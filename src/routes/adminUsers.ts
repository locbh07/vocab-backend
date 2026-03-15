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
    const where = keyword
      ? {
          OR: [
            { username: { contains: keyword, mode: 'insensitive' as const } },
            { fullname: { contains: keyword, mode: 'insensitive' as const } },
            { email: { contains: keyword, mode: 'insensitive' as const } },
          ],
        }
      : undefined;

    const [rows, total] = await Promise.all([
      prisma.userAccount.findMany({
        where,
        orderBy: { id: 'desc' },
        skip,
        take: size,
        include: {
          learningPlans: {
            where: { is_active: 1 },
            orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
      }),
      prisma.userAccount.count({ where }),
    ]);

    const userIds = rows.map((r) => r.id);
    const examCodeRows =
      userIds.length > 0
        ? await prisma.userExamCode.groupBy({
            by: ['user_id'],
            where: {
              user_id: { in: userIds },
              enabled: true,
            },
            _count: { _all: true },
          })
        : [];
    const examCodeUserIdSet = new Set(examCodeRows.map((r) => Number(r.user_id)));

    return res.json({
      items: rows.map((r: any) =>
        sanitizeUser(r, {
          activePlan: r.learningPlans?.[0] || null,
          hasExamCodeByLevel: examCodeUserIdSet.has(Number(r.id)),
        }),
      ),
      total,
      page,
      size,
    });
  });

  router.get('/:idOrUsername', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const user = await findUser(req.params.idOrUsername);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const activePlan = await prisma.userLearningPlan.findFirst({
      where: { user_id: user.id, is_active: 1 },
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
    });
    const examCodeCount = await prisma.userExamCode.count({
      where: { user_id: user.id, enabled: true },
    });
    return res.json(
      sanitizeUser(user, {
        activePlan,
        hasExamCodeByLevel: examCodeCount > 0,
      }),
    );
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
    const activePlan = await prisma.userLearningPlan.findFirst({
      where: { user_id: updated.id, is_active: 1 },
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
    });
    const examCodeCount = await prisma.userExamCode.count({
      where: { user_id: updated.id, enabled: true },
    });
    return res.json(
      sanitizeUser(updated, {
        activePlan,
        hasExamCodeByLevel: examCodeCount > 0,
      }),
    );
  });

  router.post('/:idOrUsername/impersonate', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    const target = await findUser(req.params.idOrUsername);
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (Number(target.id) === admin.id) {
      return res.status(400).json({ message: 'Cannot impersonate yourself' });
    }
    if (String(target.role || '').toUpperCase().includes('ADMIN')) {
      return res.status(403).json({ message: 'Cannot impersonate admin account' });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
    return res.json({
      user: sanitizeUser(target),
      impersonation: {
        mode: 'admin_impersonation',
        adminId: admin.id,
        adminUsername: admin.username,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    });
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

function sanitizeUser(
  user: {
  id: bigint;
  username: string;
  fullname: string;
  email: string;
  role: string;
  createdat: Date;
  exam_enabled: boolean;
  exam_code: string | null;
  },
  extras?: {
    activePlan?: { topic_prefix?: string | null } | null;
    hasExamCodeByLevel?: boolean;
  },
) {
  const topicPrefix = extras?.activePlan?.topic_prefix || null;
  const currentLevel = inferCurrentLevel(topicPrefix);
  const hasExamCode =
    Boolean(user.exam_enabled && user.exam_code && String(user.exam_code).trim()) ||
    Boolean(extras?.hasExamCodeByLevel);

  return {
    id: Number(user.id),
    username: user.username,
    fullName: user.fullname,
    email: user.email,
    role: user.role,
    createdAt: user.createdat,
    examEnabled: user.exam_enabled,
    examCode: user.exam_code,
    hasExamCode,
    currentLevel,
    topicPrefix,
  };
}

function inferCurrentLevel(topicPrefix?: string | null) {
  const raw = String(topicPrefix || '').toUpperCase();
  if (!raw || raw === 'CORE') return 'Tổng hợp';
  const match = raw.match(/N[1-5]/);
  if (match) return match[0];
  return 'Tổng hợp';
}
