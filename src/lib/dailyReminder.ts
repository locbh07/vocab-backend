import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { ensureMailboxTable } from './mailboxStore';

let ensureReminderLogTablePromise: Promise<void> | null = null;

async function ensureReminderLogTable(): Promise<void> {
  if (!ensureReminderLogTablePromise) {
    ensureReminderLogTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_daily_reminder_log (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL,
          reminder_date DATE NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_user_daily_reminder_log_user_date UNIQUE (user_id, reminder_date)
        );
      `);
    })().catch((error) => {
      ensureReminderLogTablePromise = null;
      throw error;
    });
  }
  await ensureReminderLogTablePromise;
}

const REMINDER_TITLE = 'Đừng để mất streak! 🔥';
const REMINDER_BODY = 'Hôm nay bạn chưa ôn tập từ vựng/kanji nào. Học nhanh vài phút để giữ chuỗi ngày học nhé!';
const REMINDER_LINK = '/learning-today';

// Users who reviewed recently (have an active habit worth protecting) but haven't
// reviewed anything yet today, and haven't already gotten today's reminder.
async function findReminderEligibleUserIds(): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ user_id: bigint }>>(Prisma.sql`
    WITH recently_active AS (
      SELECT DISTINCT user_id FROM user_review_log WHERE review_time >= NOW() - INTERVAL '3 days'
      UNION
      SELECT DISTINCT user_id FROM user_kanji_review_log WHERE review_time >= NOW() - INTERVAL '3 days'
    ),
    studied_today AS (
      SELECT DISTINCT user_id FROM user_review_log WHERE DATE(review_time) = CURRENT_DATE
      UNION
      SELECT DISTINCT user_id FROM user_kanji_review_log WHERE DATE(review_time) = CURRENT_DATE
    ),
    already_logged AS (
      SELECT user_id FROM user_daily_reminder_log WHERE reminder_date = CURRENT_DATE
    )
    SELECT user_id FROM recently_active
    WHERE user_id NOT IN (SELECT user_id FROM studied_today)
      AND user_id NOT IN (SELECT user_id FROM already_logged)
  `);
  return rows.map((row) => Number(row.user_id));
}

// Sends a "you haven't studied today" mailbox reminder once per user per day. Safe to
// call repeatedly (idempotent via the unique user_id+reminder_date constraint) -- the
// caller is a plain setInterval tick, not a real cron, so duplicate/overlapping calls
// (e.g. two dev-server processes) are expected and must be harmless.
export async function runDailyReminderSweep(): Promise<{ sent: number }> {
  await Promise.all([ensureMailboxTable(), ensureReminderLogTable()]);

  const userIds = await findReminderEligibleUserIds();
  let sent = 0;
  for (const userId of userIds) {
    try {
      // Claim today's slot for this user first (ON CONFLICT DO NOTHING is the actual
      // idempotency guard). Only send the mailbox message if this call is the one that
      // won the claim -- RETURNING id is empty when a concurrent tick already claimed it.
      const claimed = await prisma.$queryRaw<Array<{ id: bigint }>>(Prisma.sql`
        INSERT INTO user_daily_reminder_log (user_id, reminder_date)
        VALUES (${BigInt(userId)}, CURRENT_DATE)
        ON CONFLICT (user_id, reminder_date) DO NOTHING
        RETURNING id
      `);
      if (claimed.length === 0) continue;

      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO user_mailbox (user_id, title, body, link)
        VALUES (${BigInt(userId)}, ${REMINDER_TITLE}, ${REMINDER_BODY}, ${REMINDER_LINK})
      `);
      sent += 1;
    } catch (error) {
      console.warn(`Daily reminder failed for user ${userId}: ${(error as Error).message}`);
    }
  }
  return { sent };
}
