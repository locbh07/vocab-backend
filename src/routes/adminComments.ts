import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ensurePageCommentTable } from '../lib/commentStore';
import { requireAdmin } from '../middleware/adminGuard';

export function createAdminCommentsRouter() {
  const router = Router();

  router.delete('/:id', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensurePageCommentTable();
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Comment id không hợp lệ.' });
    }

    const deleted = await prisma.$executeRaw`
      DELETE FROM page_comment WHERE id = ${BigInt(id)}
    `;
    if (!deleted) return res.status(404).json({ message: 'Không tìm thấy bình luận.' });
    return res.status(204).send();
  });

  return router;
}
