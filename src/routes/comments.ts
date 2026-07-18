import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ensurePageCommentTable } from '../lib/commentStore';
import { requireUser } from '../middleware/userGuard';
import { formatUserLine, notificationText, notifyTelegram } from '../lib/telegram';

type CommentRow = {
  id: bigint;
  user_id: bigint;
  username: string;
  fullname: string;
  role: string;
  page_key: string;
  page_url: string | null;
  content: string;
  created_at: Date;
  updated_at: Date;
};

export function createCommentsRouter() {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    await ensurePageCommentTable();
    const pageKey = normalizePageKey(req.query.pageKey);
    if (!pageKey) return res.status(400).json({ message: 'pageKey không hợp lệ.' });

    const rows = await prisma.$queryRaw<Array<CommentRow>>`
      SELECT c.id, c.user_id, u.username, u.fullname, u.role,
             c.page_key, c.page_url, c.content, c.created_at, c.updated_at
      FROM page_comment c
      JOIN useraccount u ON u.id = c.user_id
      WHERE c.page_key = ${pageKey}
      ORDER BY c.created_at ASC
      LIMIT 200
    `;

    return res.json({ items: rows.map(toResponse) });
  });

  router.post('/', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    await ensurePageCommentTable();
    const pageKey = normalizePageKey(req.body?.pageKey);
    const pageUrl = normalizeOptionalText(req.body?.pageUrl, 1000);
    const content = normalizeContent(req.body?.content);

    if (!pageKey) return res.status(400).json({ message: 'pageKey không hợp lệ.' });
    if (!content) return res.status(400).json({ message: 'Nội dung bình luận không được để trống.' });
    if (content.length > 2000) return res.status(400).json({ message: 'Bình luận tối đa 2000 ký tự.' });

    const [created] = await prisma.$queryRaw<Array<CommentRow>>`
      WITH inserted AS (
        INSERT INTO page_comment (user_id, page_key, page_url, content)
        VALUES (${BigInt(user.id)}, ${pageKey}, ${pageUrl}, ${content})
        RETURNING *
      )
      SELECT c.id, c.user_id, u.username, u.fullname, u.role,
             c.page_key, c.page_url, c.content, c.created_at, c.updated_at
      FROM inserted c
      JOIN useraccount u ON u.id = c.user_id
    `;

    await notifyTelegram({
      title: 'New comment',
      lines: [
        `User: ${formatUserLine({
          id: created.user_id,
          username: created.username,
          fullname: created.fullname,
        })}`,
        `Page: ${created.page_key}`,
        created.page_url ? `URL: ${created.page_url}` : null,
        `Comment: ${notificationText(created.content)}`,
      ],
    });

    return res.status(201).json(toResponse(created));
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    await ensurePageCommentTable();
    const id = normalizeId(req.params.id);
    const content = normalizeContent(req.body?.content);

    if (!id) return res.status(400).json({ message: 'Comment id không hợp lệ.' });
    if (!content) return res.status(400).json({ message: 'Nội dung bình luận không được để trống.' });
    if (content.length > 2000) return res.status(400).json({ message: 'Bình luận tối đa 2000 ký tự.' });

    const rows = await prisma.$queryRaw<Array<CommentRow>>`
      UPDATE page_comment c
      SET content = ${content}, updated_at = NOW()
      FROM useraccount u
      WHERE c.id = ${BigInt(id)} AND c.user_id = ${BigInt(user.id)} AND u.id = c.user_id
      RETURNING c.id, c.user_id, u.username, u.fullname, u.role,
                c.page_key, c.page_url, c.content, c.created_at, c.updated_at
    `;

    if (!rows.length) {
      return res.status(403).json({ message: 'Bạn chỉ có thể sửa bình luận của mình.' });
    }
    return res.json(toResponse(rows[0]));
  });

  return router;
}

function normalizeId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizePageKey(value: unknown): string | null {
  const text = String(value || '').trim();
  if (!text || text.length > 300 || !text.startsWith('/')) return null;
  return text;
}

function normalizeContent(value: unknown): string {
  return String(value || '').trim();
}

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  const text = String(value || '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function toResponse(row: CommentRow) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    username: row.username,
    fullName: row.fullname,
    userRole: row.role,
    pageKey: row.page_key,
    pageUrl: row.page_url,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
