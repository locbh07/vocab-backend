import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { dateOnly } from '../lib/http';

export function createLearningRouter() {
  const router = Router();

  router.post('/plan', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    const targetMonths = Number(req.query.targetMonths);
    const topicPrefix = String(req.query.topicPrefix || '').trim();
    if (!Number.isFinite(userId) || !Number.isFinite(targetMonths) || targetMonths <= 0) {
      return res.status(400).json({ message: 'Invalid userId or targetMonths' });
    }

    const totalWords = topicPrefix
      ? await prisma.vocabulary.count({ where: { topic: { startsWith: topicPrefix } } })
      : await prisma.vocabulary.count({ where: { core_order: { not: null } } });

    await prisma.userLearningPlan.updateMany({
      where: { user_id: BigInt(userId), is_active: 1 },
      data: { is_active: 0 },
    });

    const start = new Date();
    const target = new Date(start);
    target.setMonth(target.getMonth() + targetMonths);
    const daily = Math.ceil(totalWords / (targetMonths * 30));

    await prisma.userLearningPlan.create({
      data: {
        user_id: BigInt(userId),
        total_words: totalWords,
        target_months: targetMonths,
        topic_prefix: topicPrefix || null,
        start_date: start,
        target_date: target,
        daily_new_words: daily,
        is_active: 1,
      },
    });

    const active = await getActivePlan(userId);
    return res.json(active);
  });

  router.get('/activePlan', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    return res.json(await getActivePlan(userId));
  });

  router.get('/new-words', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    const plan = await getActivePlan(userId);
    if (!plan?.daily_new_words || plan.daily_new_words <= 0) return res.json([]);

    const [usedRow] = await prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(DISTINCT vocab_id) AS total
      FROM user_review_log
      WHERE user_id = ${BigInt(userId)}
        AND mode = 'new'
        AND DATE(review_time) = CURRENT_DATE
    `;
    const used = Number(usedRow?.total || 0n);
    const remaining = plan.daily_new_words - used;
    if (remaining <= 0) return res.json([]);

    const rows = await prisma.vocabulary.findMany({
      where: {
        ...(plan.topic_prefix ? { topic: { startsWith: plan.topic_prefix } } : { core_order: { not: null } }),
        vocabProgress: { none: { user_id: BigInt(userId) } },
      },
      orderBy: [{ core_order: 'asc' }, { id: 'asc' }],
      take: remaining,
    });
    return res.json(rows);
  });

  router.get('/reviews', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    // Keep date filtering in SQL to match Java logic exactly and avoid timezone shifts.
    const dueRows = await prisma.$queryRaw<Array<{ vocab_id: bigint }>>`
      SELECT vocab_id
      FROM user_vocab_progress
      WHERE user_id = ${BigInt(userId)}
        AND is_mastered = 0
        AND next_review_date <= CURRENT_DATE
      ORDER BY next_review_date ASC
    `;
    const ids = dueRows.map((p) => p.vocab_id);
    if (!ids.length) return res.json([]);
    const words = await prisma.vocabulary.findMany({ where: { id: { in: ids } } });
    return res.json(words);
  });

  router.get('/today', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : dateOnly(new Date());
    const startDate = req.query.startDate
      ? new Date(String(req.query.startDate))
      : new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - 6);

    const rows = await prisma.$queryRaw<
      Array<{
        word_id: bigint;
        surface: string | null;
        reading: string | null;
        meaning: string | null;
        learned_at: Date | null;
        status: string;
        stage: number | null;
      }>
    >`
      SELECT
        p.vocab_id AS word_id,
        v.word_ja AS surface,
        v.word_hira_kana AS reading,
        v.word_vi AS meaning,
        p.first_seen_date AS learned_at,
        CASE WHEN p.is_mastered = 1 THEN 'mastered' ELSE 'in_progress' END AS status,
        p.stage AS stage
      FROM user_vocab_progress p
      JOIN vocabulary v ON v.id = p.vocab_id
      WHERE p.user_id = ${BigInt(userId)}
        AND p.first_seen_date >= ${dateOnly(startDate)}
        AND p.first_seen_date <= ${dateOnly(endDate)}
      ORDER BY COALESCE(p.last_reviewed_at, p.first_seen_date) DESC NULLS LAST, p.first_seen_date DESC, p.vocab_id ASC
    `;

    const items = rows.map((row: any) => ({
      wordId: Number(row.word_id),
      surface: row.surface,
      reading: row.reading,
      meaning: row.meaning,
      learnedAt: row.learned_at,
      status: row.status,
      stage: row.stage,
    }));
    return res.json({
      date: dateOnly(endDate).toISOString().slice(0, 10),
      items,
      total: items.length,
    });
  });

  router.get('/quiz/plan', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    const batchSize = 5;
    const learned = await prisma.userVocabProgress.count({ where: { user_id: BigInt(userId) } });
    const plannedSessions = Math.min(Math.max(1 + Math.floor(learned / 50), 1), 10);
    const today = dateOnly(new Date());
    const completed = await prisma.quizSession.count({
      where: { user_id: BigInt(userId), session_date: today },
    });
    const remaining = Math.max(plannedSessions - completed, 0);

    let nextSession: {
      sessionIndex: number;
      items: Array<{ wordId: number; surface: string | null; reading: string | null; meaning: string | null }>;
    } | null = null;
    if (remaining > 0) {
      const rows = await prisma.$queryRaw<
        Array<{ word_id: bigint; surface: string | null; reading: string | null; meaning: string | null }>
      >`
        SELECT p.vocab_id AS word_id, v.word_ja AS surface, v.word_hira_kana AS reading, v.word_vi AS meaning
        FROM user_vocab_progress p
        JOIN vocabulary v ON v.id = p.vocab_id
        WHERE p.user_id = ${BigInt(userId)}
          AND p.vocab_id NOT IN (
            SELECT qsi.vocab_id
            FROM quiz_session_item qsi
            JOIN quiz_session qs ON qs.id = qsi.session_id
            WHERE qs.user_id = ${BigInt(userId)}
              AND qs.session_date = ${today}
          )
        ORDER BY p.last_reviewed_at DESC NULLS LAST, p.vocab_id ASC
        LIMIT ${batchSize}
      `;
      nextSession = {
        sessionIndex: completed + 1,
        items: rows.map((r: any) => ({
          wordId: Number(r.word_id),
          surface: r.surface,
          reading: r.reading,
          meaning: r.meaning,
        })),
      };
    }

    return res.json({
      batchSize,
      plannedSessions,
      completedSessionsToday: completed,
      remainingSessionsToday: remaining,
      nextSession,
    });
  });

  router.post('/quiz/session/start', async (req: Request, res: Response) => {
    const userId = Number(req.body?.userId);
    const sessionIndex = Number(req.body?.sessionIndex);
    if (!Number.isFinite(userId) || !Number.isFinite(sessionIndex)) {
      return res.status(400).json({ message: 'Invalid userId or sessionIndex' });
    }
    const batchSize = 5;
    const today = dateOnly(new Date());

    let session = await prisma.quizSession.findFirst({
      where: { user_id: BigInt(userId), session_date: today, session_index: sessionIndex },
    });

    if (!session) {
      session = await prisma.quizSession.create({
        data: {
          user_id: BigInt(userId),
          session_date: today,
          session_index: sessionIndex,
          batch_size: batchSize,
          created_at: new Date(),
        },
      });

      const rows = await prisma.$queryRaw<Array<{ word_id: bigint }>>`
        SELECT p.vocab_id AS word_id
        FROM user_vocab_progress p
        WHERE p.user_id = ${BigInt(userId)}
          AND p.vocab_id NOT IN (
            SELECT qsi.vocab_id
            FROM quiz_session_item qsi
            JOIN quiz_session qs ON qs.id = qsi.session_id
            WHERE qs.user_id = ${BigInt(userId)}
              AND qs.session_date = ${today}
          )
        ORDER BY p.last_reviewed_at DESC NULLS LAST, p.vocab_id ASC
        LIMIT ${batchSize}
      `;
      for (let i = 0; i < rows.length; i += 1) {
        await prisma.quizSessionItem.create({
          data: {
            session_id: session.id,
            vocab_id: rows[i].word_id,
            item_order: i + 1,
            created_at: new Date(),
          },
        });
      }
    }

    const words = await prisma.$queryRaw<
      Array<{ word_id: bigint; surface: string | null; reading: string | null; meaning: string | null }>
    >`
      SELECT qsi.vocab_id AS word_id, v.word_ja AS surface, v.word_hira_kana AS reading, v.word_vi AS meaning
      FROM quiz_session_item qsi
      JOIN vocabulary v ON v.id = qsi.vocab_id
      WHERE qsi.session_id = ${session.id}
      ORDER BY qsi.item_order ASC
    `;

    return res.json({
      sessionId: Number(session.id),
      batchSize,
      items: words.map((w: any) => ({
        wordId: Number(w.word_id),
        surface: w.surface,
        reading: w.reading,
        meaning: w.meaning,
      })),
    });
  });

  router.post('/review-result', async (req: Request, res: Response) => {
    const userId = Number(req.body?.userId);
    const vocabId = Number(req.body?.vocabId);
    const correct = Boolean(req.body?.correct);
    const mode = String(req.body?.mode || 'review');
    if (!Number.isFinite(userId) || !Number.isFinite(vocabId)) {
      return res.status(400).json({ message: 'Invalid userId or vocabId' });
    }

    const plan = await getActivePlan(userId);
    const current = await prisma.userVocabProgress.findUnique({
      where: { user_id_vocab_id: { user_id: BigInt(userId), vocab_id: BigInt(vocabId) } },
    });

    const intervals = [0, 1, 3, 7, 30, 90];
    const now = new Date();
    const firstSeen = current?.first_seen_date || dateOnly(now);
    let stage = current?.stage ?? 0;
    stage = correct ? Math.min(stage + 1, 5) : Math.max(stage - 1, 0);

    const nextReview = new Date(now);
    nextReview.setDate(nextReview.getDate() + intervals[stage]);

    if (!current) {
      await prisma.userVocabProgress.create({
        data: {
          user_id: BigInt(userId),
          vocab_id: BigInt(vocabId),
          plan_id: plan?.id || null,
          stage,
          next_review_date: nextReview,
          last_reviewed_at: now,
          times_reviewed: 1,
          last_result: correct ? 1 : 0,
          is_mastered: stage >= 5 ? 1 : 0,
          first_seen_date: firstSeen,
        },
      });
    } else {
      await prisma.userVocabProgress.update({
        where: { id: current.id },
        data: {
          plan_id: current.plan_id || plan?.id || null,
          stage,
          next_review_date: nextReview,
          last_reviewed_at: now,
          times_reviewed: (current.times_reviewed || 0) + 1,
          last_result: correct ? 1 : 0,
          is_mastered: stage >= 5 ? 1 : current.is_mastered,
          first_seen_date: firstSeen,
        },
      });
    }

    await prisma.userReviewLog.create({
      data: {
        user_id: BigInt(userId),
        vocab_id: BigInt(vocabId),
        review_time: now,
        result: correct ? 1 : 0,
        mode,
      },
    });

    return res.json('OK');
  });

  router.get('/dashboard', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    const topicPrefix = String(req.query.topicPrefix || '').trim();
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    const userBigId = BigInt(userId);

    const total = topicPrefix
      ? await prisma.vocabulary.count({ where: { topic: { startsWith: topicPrefix } } })
      : await prisma.vocabulary.count({ where: { core_order: { not: null } } });
    const learned = topicPrefix
      ? await prisma.userVocabProgress.count({
          where: { user_id: userBigId, vocabulary: { topic: { startsWith: topicPrefix } } },
        })
      : await prisma.userVocabProgress.count({ where: { user_id: userBigId } });
    const mastered = topicPrefix
      ? await prisma.userVocabProgress.count({
          where: { user_id: userBigId, is_mastered: 1, vocabulary: { topic: { startsWith: topicPrefix } } },
        })
      : await prisma.userVocabProgress.count({ where: { user_id: userBigId, is_mastered: 1 } });

    const today = dateOnly(new Date());
    const rows = await prisma.$queryRaw<Array<{ study_date: Date; words: bigint }>>`
      SELECT DATE(review_time) AS study_date, COUNT(DISTINCT vocab_id) AS words
      FROM user_review_log
      WHERE user_id = ${userBigId}
      GROUP BY DATE(review_time)
      ORDER BY study_date DESC
      LIMIT 60
    `;

    const recentStudyDays: Record<string, number> = {};
    let todayReviews = 0;
    for (const row of rows) {
      const key = dateOnly(row.study_date).toISOString().slice(0, 10);
      const words = Number(row.words);
      recentStudyDays[key] = words;
      if (key === today.toISOString().slice(0, 10)) todayReviews = words;
    }

    let streak = 0;
    let cursor = dateOnly(new Date());
    while (true) {
      const key = cursor.toISOString().slice(0, 10);
      if (recentStudyDays[key] && recentStudyDays[key] > 0) {
        streak += 1;
        cursor = dateOnly(new Date(cursor.getTime() - 24 * 60 * 60 * 1000));
      } else {
        break;
      }
    }

    const [todayNewRow] = await prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(DISTINCT vocab_id) AS total
      FROM user_review_log
      WHERE user_id = ${userBigId}
        AND mode = 'new'
        AND DATE(review_time) = ${today}
    `;

    return res.json({
      totalCoreWords: total,
      learnedWords: learned,
      masteredWords: mastered,
      inProgressWords: Math.max(learned - mastered, 0),
      progressPercent: total === 0 ? 0 : (learned * 100) / total,
      todayNewWords: Number(todayNewRow?.total || 0n),
      todayReviews,
      currentStreak: streak,
      recentStudyDays,
    });
  });

  return router;
}

async function getActivePlan(userId: number) {
  return prisma.userLearningPlan.findFirst({
    where: { user_id: BigInt(userId), is_active: 1 },
    orderBy: { id: 'desc' },
  });
}
