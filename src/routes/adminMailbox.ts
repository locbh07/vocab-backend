import { Prisma } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { ensureMailboxTable } from '../lib/mailboxStore';
import { prisma } from '../lib/prisma';
import { requireAdmin } from '../middleware/adminGuard';
import { ensureFeedbackTable } from '../lib/feedbackStore';

type MailboxRow = {
  id: bigint;
  user_id: bigint;
  feedback_id: bigint | null;
  title: string;
  body: string;
  is_read: boolean;
  read_at: Date | null;
  sent_by_admin_id: bigint | null;
  created_at: Date;
  updated_at: Date;
};

export function createAdminMailboxRouter() {
  const router = Router();

  router.post('/send', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    await ensureMailboxTable();

    const userId = Number(req.body?.userId);
    const title = normalizeRequiredText(req.body?.title, 200);
    const body = normalizeRequiredText(req.body?.body ?? req.body?.message, 10_000);
    const feedbackId = normalizePositiveNumber(req.body?.feedbackId);
    const markFeedbackResolved = Boolean(req.body?.markFeedbackResolved);

    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    if (!title) {
      return res.status(400).json({ message: 'Tiêu đề là bắt buộc' });
    }
    if (!body) {
      return res.status(400).json({ message: 'Nội dung là bắt buộc' });
    }

    const user = await prisma.userAccount.findUnique({
      where: { id: BigInt(userId) },
      select: { id: true },
    });
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }

    if (feedbackId) {
      await ensureFeedbackTable();
      const feedbackRows = await prisma.$queryRaw<Array<{ id: bigint }>>(Prisma.sql`
        SELECT id
        FROM user_feedback
        WHERE id = ${BigInt(feedbackId)} AND user_id = ${BigInt(userId)}
        LIMIT 1
      `);
      if (!feedbackRows.length) {
        return res.status(404).json({ message: 'Không tìm thấy góp ý của người dùng này' });
      }
    }

    const [created] = await prisma.$queryRaw<Array<MailboxRow>>(Prisma.sql`
      INSERT INTO user_mailbox (
        user_id, feedback_id, title, body, sent_by_admin_id
      )
      VALUES (
        ${BigInt(userId)},
        ${feedbackId ? BigInt(feedbackId) : null},
        ${title},
        ${body},
        ${BigInt(admin.id)}
      )
      RETURNING id, user_id, feedback_id, title, body, is_read, read_at, sent_by_admin_id, created_at, updated_at
    `);

    if (feedbackId && markFeedbackResolved) {
      await prisma.$executeRaw(Prisma.sql`
        UPDATE user_feedback
        SET status = 'RESOLVED', updated_at = NOW()
        WHERE id = ${BigInt(feedbackId)} AND user_id = ${BigInt(userId)}
      `);
    }

    return res.status(201).json(toMailboxResponse(created));
  });

  router.get('/user/:userId', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensureMailboxTable();

    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const rows = await prisma.$queryRaw<Array<MailboxRow>>(Prisma.sql`
      SELECT id, user_id, feedback_id, title, body, is_read, read_at, sent_by_admin_id, created_at, updated_at
      FROM user_mailbox
      WHERE user_id = ${BigInt(userId)}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);

    return res.json({
      userId,
      items: rows.map((row) => toMailboxResponse(row)),
    });
  });

  return router;
}

function normalizeRequiredText(value: unknown, maxLength: number): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.slice(0, maxLength);
}

function normalizePositiveNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function toMailboxResponse(row: MailboxRow) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    feedbackId: row.feedback_id ? Number(row.feedback_id) : null,
    title: row.title,
    body: row.body,
    isRead: row.is_read,
    readAt: row.read_at,
    sentByAdminId: row.sent_by_admin_id ? Number(row.sent_by_admin_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
