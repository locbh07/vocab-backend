import { Prisma } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { ensureMailboxTable } from '../lib/mailboxStore';
import { prisma } from '../lib/prisma';

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

export function createMailboxRouter() {
  const router = Router();

  router.get('/mine', async (req: Request, res: Response) => {
    await ensureMailboxTable();

    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const unreadOnly = String(req.query.unreadOnly || '').toLowerCase() === 'true';
    const unreadClause = unreadOnly ? Prisma.sql`AND is_read = FALSE` : Prisma.empty;

    const [rows, unreadRows] = await Promise.all([
      prisma.$queryRaw<Array<MailboxRow>>(Prisma.sql`
        SELECT id, user_id, feedback_id, title, body, is_read, read_at, sent_by_admin_id, created_at, updated_at
        FROM user_mailbox
        WHERE user_id = ${BigInt(userId)} ${unreadClause}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `),
      prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS total
        FROM user_mailbox
        WHERE user_id = ${BigInt(userId)} AND is_read = FALSE
      `),
    ]);

    return res.json({
      items: rows.map((row) => toMailboxResponse(row)),
      unreadCount: Number(unreadRows?.[0]?.total || 0n),
    });
  });

  router.patch('/:id/read', async (req: Request, res: Response) => {
    await ensureMailboxTable();

    const id = Number(req.params.id);
    const userId = Number(req.body?.userId || req.query.userId);

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ message: 'id thông báo không hợp lệ' });
    }
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }

    const rows = await prisma.$queryRaw<Array<MailboxRow>>(Prisma.sql`
      UPDATE user_mailbox
      SET is_read = TRUE, read_at = COALESCE(read_at, NOW()), updated_at = NOW()
      WHERE id = ${BigInt(id)} AND user_id = ${BigInt(userId)}
      RETURNING id, user_id, feedback_id, title, body, is_read, read_at, sent_by_admin_id, created_at, updated_at
    `);
    if (!rows.length) {
      return res.status(404).json({ message: 'Không tìm thấy thông báo' });
    }

    return res.json(toMailboxResponse(rows[0]));
  });

  return router;
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
