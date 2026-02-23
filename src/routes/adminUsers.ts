import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAdmin } from '../middleware/adminGuard';
import { dateOnly } from '../lib/http';

export function createAdminUsersRouter() {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(Number(req.query.page || 0), 0);
    const size = Math.min(Math.max(Number(req.query.size || 20), 1), 200);
    const skip = page * size;

    const rows = await prisma.userAccount.findMany({
      where: keyword
        ? {
            OR: [
              { username: { contains: keyword, mode: 'insensitive' } },
              { fullname: { contains: keyword, mode: 'insensitive' } },
              { email: { contains: keyword, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { id: 'desc' },
      skip,
      take: size,
    });

    return res.json(rows.map((r: any) => sanitizeUser(r)));
  });

  router.get('/:idOrUsername', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const user = await findUser(req.params.idOrUsername);
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json(sanitizeUser(user));
  });

  router.put('/:idOrUsername', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const user = await findUser(req.params.idOrUsername);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const body = req.body || {};

    const data: Record<string, unknown> = {};
    if (body.fullName !== undefined) data.fullname = body.fullName;
    if (body.email !== undefined) data.email = body.email;
    if (body.role !== undefined) data.role = body.role;
    if (body.examEnabled !== undefined) data.exam_enabled = Boolean(body.examEnabled);
    if (body.examCode !== undefined) data.exam_code = body.examCode;
    if (Object.keys(data).length === 0) return res.status(400).json({ message: 'No fields to update' });

    const updated = await prisma.userAccount.update({
      where: { id: user.id },
      data,
    });
    return res.json(sanitizeUser(updated));
  });

  router.get('/:userId/stats', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    const userBigId = BigInt(userId);

    const [studyDayRow] = await prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(DISTINCT d) AS total
      FROM (
        SELECT DATE(first_seen_date) AS d FROM user_vocab_progress WHERE user_id = ${userBigId} AND first_seen_date IS NOT NULL
        UNION
        SELECT DATE(last_reviewed_at) AS d FROM user_vocab_progress WHERE user_id = ${userBigId} AND last_reviewed_at IS NOT NULL
      ) t
    `;
    const [lastStudyDateRow] = await prisma.$queryRaw<Array<{ d: Date | null }>>`
      SELECT MAX(d) AS d
      FROM (
        SELECT DATE(first_seen_date) AS d FROM user_vocab_progress WHERE user_id = ${userBigId} AND first_seen_date IS NOT NULL
        UNION
        SELECT DATE(last_reviewed_at) AS d FROM user_vocab_progress WHERE user_id = ${userBigId} AND last_reviewed_at IS NOT NULL
      ) t
    `;
    const [learnedRow] = await prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*) AS total FROM user_vocab_progress WHERE user_id = ${userBigId}
    `;
    const days = await prisma.$queryRaw<Array<{ study_date: Date; words: bigint }>>`
      SELECT d AS study_date, COUNT(*) AS words
      FROM (
        SELECT DATE(first_seen_date) AS d FROM user_vocab_progress WHERE user_id = ${userBigId} AND first_seen_date IS NOT NULL
        UNION ALL
        SELECT DATE(last_reviewed_at) AS d FROM user_vocab_progress WHERE user_id = ${userBigId} AND last_reviewed_at IS NOT NULL
      ) t
      GROUP BY d
      ORDER BY d DESC
      LIMIT 365
    `;

    const dateSet = new Set(days.map((r: { study_date: Date }) => dateOnly(r.study_date).toISOString().slice(0, 10)));
    let streak = 0;
    let cursor = dateOnly(new Date());
    while (true) {
      const key = cursor.toISOString().slice(0, 10);
      if (dateSet.has(key)) {
        streak += 1;
        cursor = dateOnly(new Date(cursor.getTime() - 24 * 60 * 60 * 1000));
      } else {
        break;
      }
    }

    return res.json({
      totalStudyDays: Number(studyDayRow?.total || 0n),
      lastStudyDate: lastStudyDateRow?.d ? dateOnly(lastStudyDateRow.d).toISOString().slice(0, 10) : null,
      totalLearnedVocab: Number(learnedRow?.total || 0n),
      currentStreakDays: streak,
    });
  });

  router.get('/:userId/exam-codes', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    const rows = await prisma.userExamCode.findMany({
      where: { user_id: BigInt(userId) },
      orderBy: { level: 'asc' },
    });
    return res.json(rows);
  });

  router.put('/:userId/exam-codes', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    const items = Array.isArray(req.body) ? req.body : [];
    if (!items.length) return res.status(400).json({ message: 'No exam codes provided' });

    let updated = 0;
    for (const item of items) {
      if (!item?.level || item?.code === undefined || item?.code === null) continue;
      await prisma.userExamCode.upsert({
        where: {
          user_id_level: { user_id: BigInt(userId), level: String(item.level) },
        },
        create: {
          user_id: BigInt(userId),
          level: String(item.level),
          code: String(item.code),
          enabled: item.enabled === undefined ? true : Boolean(item.enabled),
        },
        update: {
          code: String(item.code),
          enabled: item.enabled === undefined ? true : Boolean(item.enabled),
          updated_at: new Date(),
        },
      });
      updated += 1;
    }

    return res.json({ updated });
  });

  return router;
}

async function findUser(idOrUsername: string) {
  if (/^\d+$/.test(idOrUsername)) {
    return prisma.userAccount.findUnique({ where: { id: BigInt(Number(idOrUsername)) } });
  }
  return prisma.userAccount.findUnique({ where: { username: idOrUsername } });
}

function sanitizeUser(user: {
  id: bigint;
  username: string;
  fullname: string;
  email: string;
  role: string;
  createdat: Date;
  exam_enabled: boolean;
  exam_code: string | null;
}) {
  return {
    id: Number(user.id),
    username: user.username,
    fullName: user.fullname,
    email: user.email,
    role: user.role,
    createdAt: user.createdat,
    examEnabled: user.exam_enabled,
    examCode: user.exam_code,
  };
}
