import { Prisma } from '@prisma/client';
import { Router, Request, Response } from 'express';
import { ensureFeedbackTable, FEEDBACK_STATUSES, normalizeFeedbackStatus } from '../lib/feedbackStore';
import { requireAdmin } from '../middleware/adminGuard';
import { prisma } from '../lib/prisma';

type FeedbackListRow = {
  id: bigint;
  user_id: bigint;
  username: string | null;
  fullname: string | null;
  message: string;
  context: string | null;
  page_url: string | null;
  status: string;
  admin_note: string | null;
  created_at: Date;
  updated_at: Date;
};

type CountRow = {
  total: bigint;
};

export function createAdminFeedbackRouter() {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensureFeedbackTable();

    const page = Math.max(Number(req.query.page || 0), 0);
    const size = Math.min(Math.max(Number(req.query.size || 20), 1), 100);
    const skip = page * size;

    const keyword = String(req.query.keyword || '').trim();
    const status = normalizeStatusQuery(req.query.status);
    const userId = Number(req.query.userId);
    const hasUserId = Number.isFinite(userId) && userId > 0;

    const where = buildWhereClause({ keyword, status, userId: hasUserId ? userId : null });

    const [countRows, rows] = await Promise.all([
      prisma.$queryRaw<Array<CountRow>>(Prisma.sql`
        SELECT COUNT(*) AS total
        FROM user_feedback f
        JOIN useraccount u ON u.id = f.user_id
        ${where}
      `),
      prisma.$queryRaw<Array<FeedbackListRow>>(Prisma.sql`
        SELECT
          f.id, f.user_id, u.username, u.fullname, f.message, f.context, f.page_url, f.status, f.admin_note, f.created_at, f.updated_at
        FROM user_feedback f
        JOIN useraccount u ON u.id = f.user_id
        ${where}
        ORDER BY f.created_at DESC
        OFFSET ${skip}
        LIMIT ${size}
      `),
    ]);

    const total = Number(countRows?.[0]?.total || 0n);
    return res.json({
      page,
      size,
      total,
      items: rows.map((row) => toResponse(row)),
    });
  });

  router.get('/statuses', async (req: Request, res: Response) => {
    await requireAdmin(req);
    return res.json({ statuses: FEEDBACK_STATUSES });
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensureFeedbackTable();

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ message: 'Invalid feedback id' });
    }

    const statusInput = req.body?.status;
    const adminNote = normalizeOptionalText(req.body?.adminNote, 5000);
    const hasStatus = statusInput !== undefined && statusInput !== null && String(statusInput).trim().length > 0;
    const nextStatus = hasStatus ? normalizeFeedbackStatus(statusInput) : null;
    const hasAdminNote = req.body && Object.prototype.hasOwnProperty.call(req.body, 'adminNote');

    if (!hasStatus && !hasAdminNote) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    const sets: Prisma.Sql[] = [Prisma.sql`updated_at = NOW()`];
    if (nextStatus) sets.push(Prisma.sql`status = ${nextStatus}`);
    if (hasAdminNote) sets.push(Prisma.sql`admin_note = ${adminNote}`);

    const setClause = Prisma.join(sets, ', ');
    const updatedRows = await prisma.$queryRaw<Array<FeedbackListRow>>(Prisma.sql`
      UPDATE user_feedback f
      SET ${setClause}
      FROM useraccount u
      WHERE f.id = ${BigInt(id)} AND u.id = f.user_id
      RETURNING
        f.id, f.user_id, u.username, u.fullname, f.message, f.context, f.page_url, f.status, f.admin_note, f.created_at, f.updated_at
    `);

    if (!updatedRows.length) {
      return res.status(404).json({ message: 'Feedback not found' });
    }

    return res.json(toResponse(updatedRows[0]));
  });

  return router;
}

function normalizeStatusQuery(value: unknown): string | null {
  const text = String(value || '')
    .trim()
    .toUpperCase();
  if (!text || text === 'ALL') return null;
  return FEEDBACK_STATUSES.includes(text as any) ? text : null;
}

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function buildWhereClause({
  keyword,
  status,
  userId,
}: {
  keyword: string;
  status: string | null;
  userId: number | null;
}) {
  const clauses: Prisma.Sql[] = [];

  if (status) clauses.push(Prisma.sql`f.status = ${status}`);
  if (userId) clauses.push(Prisma.sql`f.user_id = ${BigInt(userId)}`);
  if (keyword) {
    const token = `%${keyword}%`;
    clauses.push(
      Prisma.sql`(
        u.username ILIKE ${token}
        OR u.fullname ILIKE ${token}
        OR u.email ILIKE ${token}
        OR f.message ILIKE ${token}
      )`,
    );
  }

  if (!clauses.length) return Prisma.empty;
  return Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}`;
}

function toResponse(row: FeedbackListRow) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    username: row.username || null,
    fullName: row.fullname || null,
    message: row.message,
    context: row.context,
    pageUrl: row.page_url,
    status: normalizeFeedbackStatus(row.status),
    adminNote: row.admin_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
