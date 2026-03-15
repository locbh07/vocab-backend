import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ensureFeedbackTable, normalizeFeedbackStatus } from '../lib/feedbackStore';

type FeedbackInsertRow = {
  id: bigint;
  user_id: bigint;
  message: string;
  context: string | null;
  page_url: string | null;
  status: string;
  admin_note: string | null;
  created_at: Date;
  updated_at: Date;
};

export function createFeedbackRouter() {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    await ensureFeedbackTable();

    const userId = Number(req.body?.userId);
    const message = String(req.body?.message || '').trim();
    const context = normalizeOptionalText(req.body?.context, 200);
    const pageUrl = normalizeOptionalText(req.body?.pageUrl, 1000);

    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ message: 'Invalid userId' });
    }

    if (!message) {
      return res.status(400).json({ message: 'Nội dung góp ý không được để trống.' });
    }

    if (message.length > 5000) {
      return res.status(400).json({ message: 'Nội dung góp ý quá dài (tối đa 5000 ký tự).' });
    }

    const user = await prisma.userAccount.findUnique({
      where: { id: BigInt(userId) },
      select: { id: true, username: true, fullname: true },
    });

    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản người dùng.' });
    }

    const [created] = await prisma.$queryRaw<Array<FeedbackInsertRow>>`
      INSERT INTO user_feedback (user_id, message, context, page_url, status)
      VALUES (${BigInt(userId)}, ${message}, ${context}, ${pageUrl}, 'NEW')
      RETURNING id, user_id, message, context, page_url, status, admin_note, created_at, updated_at
    `;

    return res.status(201).json(toFeedbackResponse(created, user.username, user.fullname));
  });

  router.get('/mine', async (req: Request, res: Response) => {
    await ensureFeedbackTable();

    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ message: 'Invalid userId' });
    }

    const rows = await prisma.$queryRaw<Array<FeedbackInsertRow>>`
      SELECT id, user_id, message, context, page_url, status, admin_note, created_at, updated_at
      FROM user_feedback
      WHERE user_id = ${BigInt(userId)}
      ORDER BY created_at DESC
      LIMIT 50
    `;

    return res.json(rows.map((row) => toFeedbackResponse(row)));
  });

  return router;
}

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function toFeedbackResponse(
  row: FeedbackInsertRow,
  username?: string | null,
  fullName?: string | null,
) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    username: username || null,
    fullName: fullName || null,
    message: row.message,
    context: row.context,
    pageUrl: row.page_url,
    status: normalizeFeedbackStatus(row.status),
    adminNote: row.admin_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

