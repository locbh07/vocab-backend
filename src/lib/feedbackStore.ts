import { prisma } from './prisma';

let ensureTablePromise: Promise<void> | null = null;

export const FEEDBACK_STATUSES = ['NEW', 'READ', 'RESOLVED'] as const;
export type FeedbackStatus = typeof FEEDBACK_STATUSES[number];

export async function ensureFeedbackTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_feedback (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES useraccount(id) ON DELETE CASCADE,
          message TEXT NOT NULL,
          context TEXT NULL,
          page_url TEXT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'NEW',
          admin_note TEXT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_feedback_status_created
          ON user_feedback(status, created_at DESC);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_feedback_user_created
          ON user_feedback(user_id, created_at DESC);
      `);
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }

  await ensureTablePromise;
}

export function normalizeFeedbackStatus(value: unknown): FeedbackStatus {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  if (FEEDBACK_STATUSES.includes(normalized as FeedbackStatus)) {
    return normalized as FeedbackStatus;
  }
  return 'NEW';
}

