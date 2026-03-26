import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma';
import { dateOnly } from '../lib/http';

const JLPT_LEVELS = ['ALL', 'N5', 'N4', 'N3', 'N2', 'N1'] as const;
type JlptLevel = (typeof JLPT_LEVELS)[number];
type VocabTrack = 'core' | 'book';

type VocabScope = {
  track: VocabTrack;
  topicPrefix: string | null;
  sourceBook: string | null;
  sourceUnit: string | null;
};

function normalizeVocabTrack(value: unknown): VocabTrack {
  const track = String(value || 'core').trim().toLowerCase();
  return track === 'book' ? 'book' : 'core';
}

function normalizeOptionalText(value: unknown): string | null {
  const text = String(value || '').trim();
  return text.length ? text : null;
}

function buildScopeFromQuery(query: Request['query']): VocabScope {
  const track = normalizeVocabTrack(query.track);
  const topicPrefix = normalizeOptionalText(query.topicPrefix);
  const sourceBook = normalizeOptionalText(query.sourceBook);
  const sourceUnit = normalizeOptionalText(query.sourceUnit);

  if (track === 'book') {
    return {
      track: 'book',
      topicPrefix: null,
      sourceBook,
      sourceUnit,
    };
  }

  return {
    track: 'core',
    topicPrefix,
    sourceBook: null,
    sourceUnit: null,
  };
}

function buildScopeFromPlan(plan: any): VocabScope {
  const track = normalizeVocabTrack(plan?.track);
  const topicPrefix = normalizeOptionalText(plan?.topic_prefix);
  const sourceBook = normalizeOptionalText(plan?.source_book);
  const sourceUnit = normalizeOptionalText(plan?.source_unit);

  if (track === 'book') {
    return {
      track: 'book',
      topicPrefix: null,
      sourceBook,
      sourceUnit,
    };
  }

  return {
    track: 'core',
    topicPrefix,
    sourceBook: null,
    sourceUnit: null,
  };
}

function buildVocabularyScopeWhere(scope: VocabScope) {
  if (scope.track === 'book') {
    return {
      track: 'book',
      ...(scope.sourceBook ? { source_book: scope.sourceBook } : {}),
      ...(scope.sourceUnit ? { source_unit: scope.sourceUnit } : {}),
    };
  }
  if (scope.topicPrefix) {
    return {
      track: 'core',
      topic: { startsWith: scope.topicPrefix },
    };
  }
  return {
    track: 'core',
    core_order: { not: null },
  };
}

function formatLocalDateKey(dateValue: Date): string {
  const d = dateOnly(dateValue);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

type KanjiTodayCacheEntry = {
  ts: number;
  payload: {
    plan: KanjiLearningPlan | null;
    newKanji: ReturnType<typeof mapKanjiLearningItem>[];
    reviewKanji: ReturnType<typeof mapKanjiLearningItem>[];
  };
};

const KANJI_TODAY_CACHE_TTL_MS = 15_000;
const kanjiTodayCacheByUser = new Map<number, KanjiTodayCacheEntry>();

function readKanjiTodayCache(userId: number) {
  const entry = kanjiTodayCacheByUser.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > KANJI_TODAY_CACHE_TTL_MS) {
    kanjiTodayCacheByUser.delete(userId);
    return null;
  }
  return entry.payload;
}

function writeKanjiTodayCache(
  userId: number,
  payload: {
    plan: KanjiLearningPlan | null;
    newKanji: ReturnType<typeof mapKanjiLearningItem>[];
    reviewKanji: ReturnType<typeof mapKanjiLearningItem>[];
  },
) {
  kanjiTodayCacheByUser.set(userId, {
    ts: Date.now(),
    payload,
  });
}

function invalidateKanjiTodayCache(userId: number) {
  kanjiTodayCacheByUser.delete(userId);
}

export function createLearningRouter() {
  const router = Router();

  router.post('/plan', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    const targetMonths = Number(req.query.targetMonths);
    const scope = buildScopeFromQuery(req.query);
    if (!Number.isFinite(userId) || !Number.isFinite(targetMonths) || targetMonths <= 0) {
      return res.status(400).json({ message: 'Invalid userId or targetMonths' });
    }

    if (scope.track === 'book' && !scope.sourceBook) {
      return res.status(400).json({ message: 'sourceBook is required when track=book' });
    }

    const totalWords = await prisma.vocabulary.count({ where: buildVocabularyScopeWhere(scope) });

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
        topic_prefix: scope.topicPrefix,
        track: scope.track,
        source_book: scope.sourceBook,
        source_unit: scope.sourceUnit,
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

    const scope = buildScopeFromPlan(plan);
    const orderBy =
      scope.track === 'core'
        ? ([{ core_order: 'asc' }, { id: 'asc' }] as const)
        : ([{ source_book: 'asc' }, { source_unit: 'asc' }, { id: 'asc' }] as const);

    const rows = await prisma.vocabulary.findMany({
      where: {
        ...buildVocabularyScopeWhere(scope),
        vocabProgress: { none: { user_id: BigInt(userId) } },
      },
      orderBy: orderBy as any,
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
      date: formatLocalDateKey(endDate),
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

  router.post('/kanji/plan', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId ?? req.body?.userId);
    const targetMonths = Number(req.query.targetMonths ?? req.body?.targetMonths ?? 6);
    const jlptLevel = normalizeJlptLevel(req.query.jlptLevel ?? req.body?.jlptLevel ?? 'ALL');
    if (!Number.isFinite(userId) || !Number.isFinite(targetMonths) || targetMonths <= 0) {
      return res.status(400).json({ message: 'Invalid userId or targetMonths' });
    }
    await ensureKanjiLearningTables();

    const totalKanji = await countKanjiByJlptLevel(jlptLevel);
    if (totalKanji <= 0) {
      return res.status(400).json({ message: 'No kanji found for this level. Build kanji dataset first.' });
    }

    const userBigId = BigInt(userId);
    const start = dateOnly(new Date());
    const target = dateOnly(new Date(start));
    target.setMonth(target.getMonth() + targetMonths);
    const daily = Math.max(1, Math.ceil(totalKanji / (targetMonths * 30)));

    await prisma.$executeRawUnsafe(
      `
        UPDATE user_kanji_learning_plan
        SET is_active = 0, updated_at = NOW()
        WHERE user_id = $1
          AND is_active = 1
      `,
      userBigId,
    );

    await prisma.$queryRawUnsafe(
      `
        INSERT INTO user_kanji_learning_plan (
          user_id, total_kanji, target_months, jlpt_level, start_date, target_date, daily_new_kanji, is_active, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 1, NOW(), NOW())
      `,
      userBigId,
      totalKanji,
      Math.floor(targetMonths),
      jlptLevel,
      start,
      target,
      daily,
    );

    const activePlan = await getActiveKanjiPlan(userId);
    if (activePlan?.id) {
      await rebuildKanjiPlanItemsForPlan(userId, activePlan);
    }
    invalidateKanjiTodayCache(userId);
    return res.json(activePlan);
  });

  router.get('/kanji/activePlan', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    await ensureKanjiLearningTables();
    return res.json(await getActiveKanjiPlan(userId));
  });

  router.get('/kanji/count', async (req: Request, res: Response) => {
    const jlptLevel = normalizeJlptLevel(req.query.jlptLevel ?? 'ALL');
    await ensureKanjiLearningTables();
    const total = await countKanjiByJlptLevel(jlptLevel);
    return res.json({ jlptLevel, total });
  });

  router.get('/kanji/new', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    await ensureKanjiLearningTables();
    const plan = await getActiveKanjiPlan(userId);
    if (!plan?.dailyNewKanji || plan.dailyNewKanji <= 0) return res.json([]);
    await ensureKanjiPlanItemsForPlan(userId, plan);
    const rows = await listScheduledNewKanjiRows(userId, plan);
    return res.json(rows.map(mapKanjiLearningItem));
  });

  router.get('/kanji/reviews', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    await ensureKanjiLearningTables();

    const rows = await listDueKanjiRows(userId);
    return res.json(rows.map(mapKanjiLearningItem));
  });

  router.get('/kanji/today', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    await ensureKanjiLearningTables();

    const cached = readKanjiTodayCache(userId);
    if (cached) {
      return res.json(cached);
    }

    const plan = await getActiveKanjiPlan(userId);
    const reviewPromise = listDueKanjiRows(userId);
    if (!plan?.dailyNewKanji || plan.dailyNewKanji <= 0) {
      const reviewRows = await reviewPromise;
      const payload = {
        plan: plan || null,
        newKanji: [],
        reviewKanji: reviewRows.map(mapKanjiLearningItem),
      };
      writeKanjiTodayCache(userId, payload);
      return res.json(payload);
    }

    await ensureKanjiPlanItemsForPlan(userId, plan);
    const [newRows, reviewRows] = await Promise.all([
      listScheduledNewKanjiRows(userId, plan),
      reviewPromise,
    ]);

    const payload = {
      plan,
      newKanji: newRows.map(mapKanjiLearningItem),
      reviewKanji: reviewRows.map(mapKanjiLearningItem),
    };
    writeKanjiTodayCache(userId, payload);
    return res.json(payload);
  });

  router.post('/kanji/review-result', async (req: Request, res: Response) => {
    const userId = Number(req.body?.userId);
    const kanji = String(req.body?.kanji || '').trim();
    const correct = Boolean(req.body?.correct);
    const mode = String(req.body?.mode || 'review').trim() || 'review';
    if (!Number.isFinite(userId) || !kanji) {
      return res.status(400).json({ message: 'Invalid userId or kanji' });
    }
    await ensureKanjiLearningTables();
    const plan = await getActiveKanjiPlan(userId);

    const intervals = [0, 1, 3, 7, 14, 30];
    const now = new Date();
    const firstSeen = dateOnly(now);

    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{ id: bigint; stage: number | null; times_reviewed: number | null; is_mastered: number | null; plan_id: bigint | null; first_seen_date: Date | null }>
      >(
        `
          SELECT id, stage, times_reviewed, is_mastered, plan_id, first_seen_date
          FROM user_kanji_progress
          WHERE user_id = $1
            AND kanji_char = $2
          LIMIT 1
        `,
        BigInt(userId),
        kanji,
      );
      const current = rows[0] || null;
      let stage = Number(current?.stage ?? 0);
      stage = correct ? Math.min(stage + 1, 5) : Math.max(stage - 1, 0);

      const nextReview = new Date(now);
      nextReview.setDate(nextReview.getDate() + intervals[stage]);

      if (!current) {
        await tx.$executeRawUnsafe(
          `
            INSERT INTO user_kanji_progress (
              user_id, kanji_char, plan_id, stage, next_review_date, last_reviewed_at,
              times_reviewed, last_result, is_mastered, first_seen_date, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, NOW(), NOW())
          `,
          BigInt(userId),
          kanji,
          plan?.id ? BigInt(plan.id) : null,
          stage,
          nextReview,
          now,
          correct ? 1 : 0,
          stage >= 5 ? 1 : 0,
          firstSeen,
        );
      } else {
        await tx.$executeRawUnsafe(
          `
            UPDATE user_kanji_progress
            SET
              plan_id = COALESCE(plan_id, $1),
              stage = $2,
              next_review_date = $3,
              last_reviewed_at = $4,
              times_reviewed = COALESCE(times_reviewed, 0) + 1,
              last_result = $5,
              is_mastered = CASE WHEN $6 = 1 THEN 1 ELSE COALESCE(is_mastered, 0) END,
              first_seen_date = COALESCE(first_seen_date, $7),
              updated_at = NOW()
            WHERE id = $8
          `,
          plan?.id ? BigInt(plan.id) : null,
          stage,
          nextReview,
          now,
          correct ? 1 : 0,
          stage >= 5 ? 1 : 0,
          firstSeen,
          current.id,
        );
      }

      await tx.$executeRawUnsafe(
        `
          INSERT INTO user_kanji_review_log (user_id, kanji_char, review_time, result, mode)
          VALUES ($1, $2, $3, $4, $5)
        `,
        BigInt(userId),
        kanji,
        now,
        correct ? 1 : 0,
        mode,
      );

      if (mode === 'new' && plan?.id) {
        await tx.$executeRawUnsafe(
          `
            UPDATE user_kanji_plan_item
            SET
              status = 'done',
              first_result = COALESCE(first_result, $1),
              reviewed_at = COALESCE(reviewed_at, $2),
              updated_at = NOW()
            WHERE user_id = $3
              AND plan_id = $4
              AND kanji_char = $5
          `,
          correct ? 1 : 0,
          now,
          BigInt(userId),
          BigInt(plan.id),
          kanji,
        );
      }
    });

    invalidateKanjiTodayCache(userId);

    return res.json('OK');
  });

  router.get('/kanji/dashboard', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    await ensureKanjiLearningTables();
    const userBigId = BigInt(userId);

    const [learnedKanji, masteredKanji] = await Promise.all([
      prisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(*)::bigint AS total
        FROM user_kanji_progress
        WHERE user_id = ${userBigId}
      `,
      prisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(*)::bigint AS total
        FROM user_kanji_progress
        WHERE user_id = ${userBigId}
          AND is_mastered = 1
      `,
    ]);

    const today = dateOnly(new Date());
    const rows = await prisma.$queryRaw<Array<{ study_date: Date; items: bigint }>>`
      SELECT DATE(review_time) AS study_date, COUNT(DISTINCT kanji_char) AS items
      FROM user_kanji_review_log
      WHERE user_id = ${userBigId}
      GROUP BY DATE(review_time)
      ORDER BY study_date DESC
      LIMIT 90
    `;
    const streakRows = await prisma.$queryRaw<Array<{ study_date: Date }>>`
      SELECT DATE(review_time) AS study_date
      FROM user_kanji_review_log
      WHERE user_id = ${userBigId}
      GROUP BY DATE(review_time)
      ORDER BY study_date ASC
    `;

    const recentStudyDays: Record<string, number> = {};
    let todayReviews = 0;
    for (const row of rows) {
      const key = formatLocalDateKey(row.study_date);
      const items = Number(row.items);
      recentStudyDays[key] = items;
      if (key === formatLocalDateKey(today)) todayReviews = items;
    }
    const longestStreak = calculateLongestStreakFromKeys(
      streakRows.map((row) => formatLocalDateKey(row.study_date)),
    );

    let streak = 0;
    let cursor = dateOnly(new Date());
    while (true) {
      const key = formatLocalDateKey(cursor);
      if (recentStudyDays[key] && recentStudyDays[key] > 0) {
        streak += 1;
        cursor = dateOnly(new Date(cursor.getTime() - 24 * 60 * 60 * 1000));
      } else {
        break;
      }
    }

    const [todayNewRow] = await prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(DISTINCT kanji_char) AS total
      FROM user_kanji_review_log
      WHERE user_id = ${userBigId}
        AND mode = 'new'
        AND DATE(review_time) = ${today}
    `;

    const activePlan = await getActiveKanjiPlan(userId);

    return res.json({
      totalPlanKanji: activePlan?.totalKanji || 0,
      learnedKanji: Number(learnedKanji?.[0]?.total || 0n),
      masteredKanji: Number(masteredKanji?.[0]?.total || 0n),
      inProgressKanji: Math.max(Number(learnedKanji?.[0]?.total || 0n) - Number(masteredKanji?.[0]?.total || 0n), 0),
      todayNewKanji: Number(todayNewRow?.total || 0n),
      todayReviews,
      currentStreak: streak,
      longestStreak,
      recentStudyDays,
    });
  });

  router.get('/dashboard', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    const scope = buildScopeFromQuery(req.query);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    const userBigId = BigInt(userId);

    const vocabWhere = buildVocabularyScopeWhere(scope);
    const total = await prisma.vocabulary.count({ where: vocabWhere as any });
    const learned = await prisma.userVocabProgress.count({
      where: { user_id: userBigId, vocabulary: vocabWhere as any },
    });
    const mastered = await prisma.userVocabProgress.count({
      where: { user_id: userBigId, is_mastered: 1, vocabulary: vocabWhere as any },
    });

    const today = dateOnly(new Date());
    const rows = await prisma.$queryRaw<Array<{ study_date: Date; words: bigint }>>`
      SELECT DATE(review_time) AS study_date, COUNT(DISTINCT vocab_id) AS words
      FROM user_review_log
      WHERE user_id = ${userBigId}
      GROUP BY DATE(review_time)
      ORDER BY study_date DESC
      LIMIT 60
    `;
    const streakRows = await prisma.$queryRaw<Array<{ study_date: Date }>>`
      SELECT DATE(review_time) AS study_date
      FROM user_review_log
      WHERE user_id = ${userBigId}
      GROUP BY DATE(review_time)
      ORDER BY study_date ASC
    `;

    const recentStudyDays: Record<string, number> = {};
    let todayReviews = 0;
    for (const row of rows) {
      const key = formatLocalDateKey(row.study_date);
      const words = Number(row.words);
      recentStudyDays[key] = words;
      if (key === formatLocalDateKey(today)) todayReviews = words;
    }
    const longestStreak = calculateLongestStreakFromKeys(
      streakRows.map((row) => formatLocalDateKey(row.study_date)),
    );

    let streak = 0;
    let cursor = dateOnly(new Date());
    while (true) {
      const key = formatLocalDateKey(cursor);
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
      longestStreak,
      recentStudyDays,
    });
  });

  router.get('/streak-leaderboard', async (req: Request, res: Response) => {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(20, Math.floor(requestedLimit)))
      : 5;

    await ensureKanjiLearningTables();

    const vocabRows = await prisma.$queryRaw<
      Array<{ user_id: bigint; full_name: string | null; longest_streak: bigint }>
    >`
      WITH daily AS (
        SELECT user_id, DATE(review_time) AS study_date
        FROM user_review_log
        GROUP BY user_id, DATE(review_time)
      ),
      grouped AS (
        SELECT
          user_id,
          study_date,
          study_date - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY study_date)::int) AS streak_group
        FROM daily
      ),
      streaks AS (
        SELECT user_id, COUNT(*)::bigint AS streak_len
        FROM grouped
        GROUP BY user_id, streak_group
      ),
      best AS (
        SELECT user_id, MAX(streak_len)::bigint AS longest_streak
        FROM streaks
        GROUP BY user_id
      )
      SELECT b.user_id, u.fullname AS full_name, b.longest_streak
      FROM best b
      JOIN useraccount u ON u.id = b.user_id
      ORDER BY b.longest_streak DESC, u.fullname ASC
      LIMIT ${limit}
    `;

    const kanjiRows = await prisma.$queryRaw<
      Array<{ user_id: bigint; full_name: string | null; longest_streak: bigint }>
    >`
      WITH daily AS (
        SELECT user_id, DATE(review_time) AS study_date
        FROM user_kanji_review_log
        GROUP BY user_id, DATE(review_time)
      ),
      grouped AS (
        SELECT
          user_id,
          study_date,
          study_date - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY study_date)::int) AS streak_group
        FROM daily
      ),
      streaks AS (
        SELECT user_id, COUNT(*)::bigint AS streak_len
        FROM grouped
        GROUP BY user_id, streak_group
      ),
      best AS (
        SELECT user_id, MAX(streak_len)::bigint AS longest_streak
        FROM streaks
        GROUP BY user_id
      )
      SELECT b.user_id, u.fullname AS full_name, b.longest_streak
      FROM best b
      JOIN useraccount u ON u.id = b.user_id
      ORDER BY b.longest_streak DESC, u.fullname ASC
      LIMIT ${limit}
    `;

    return res.json({
      limit,
      vocab: vocabRows.map((row, index) => ({
        rank: index + 1,
        userId: Number(row.user_id),
        fullName: String(row.full_name || `User ${row.user_id.toString()}`),
        longestStreak: Number(row.longest_streak || 0n),
      })),
      kanji: kanjiRows.map((row, index) => ({
        rank: index + 1,
        userId: Number(row.user_id),
        fullName: String(row.full_name || `User ${row.user_id.toString()}`),
        longestStreak: Number(row.longest_streak || 0n),
      })),
    });
  });

  return router;
}

function calculateLongestStreakFromKeys(keys: string[]): number {
  if (!keys.length) return 0;
  const uniqueSortedKeys = [...new Set(keys)].sort();
  let best = 1;
  let run = 1;

  for (let i = 1; i < uniqueSortedKeys.length; i += 1) {
    const prev = parseDateKey(uniqueSortedKeys[i - 1]);
    const current = parseDateKey(uniqueSortedKeys[i]);
    if (!prev || !current) continue;
    const diff = current.getTime() - prev.getTime();
    if (diff === 24 * 60 * 60 * 1000) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }

  return best;
}

function parseDateKey(key: string): Date | null {
  if (!key) return null;
  const [yearRaw, monthRaw, dayRaw] = key.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return new Date(year, month - 1, day);
}

async function getActivePlan(userId: number) {
  return prisma.userLearningPlan.findFirst({
    where: { user_id: BigInt(userId), is_active: 1 },
    orderBy: { id: 'desc' },
  });
}

type KanjiLearningPlanRow = {
  id: bigint;
  user_id: bigint;
  total_kanji: number | null;
  target_months: number | null;
  jlpt_level: string | null;
  start_date: Date | null;
  target_date: Date | null;
  daily_new_kanji: number | null;
  is_active: number | null;
  created_at: Date;
  updated_at: Date;
};

type KanjiLearningPlan = {
  id: number;
  userId: number;
  totalKanji: number;
  targetMonths: number;
  jlptLevel: JlptLevel;
  startDate: Date | null;
  targetDate: Date | null;
  dailyNewKanji: number;
  isActive: number;
  createdAt: Date;
  updatedAt: Date;
};

type KanjiLearningItemRow = {
  kanji_char: string;
  stage?: number | null;
  next_review_date?: Date | null;
  min_priority?: number | null;
  example_word_ja?: string | null;
  example_reading_kana?: string | null;
  example_meaning_vi?: string | null;
  example_meaning_en?: string | null;
};

let ensureKanjiLearningTablesPromise: Promise<void> | null = null;

async function ensureKanjiLearningTables() {
  if (!ensureKanjiLearningTablesPromise) {
    ensureKanjiLearningTablesPromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_kanji_learning_plan (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL,
          total_kanji INT,
          target_months INT,
          jlpt_level VARCHAR(5) NOT NULL DEFAULT 'ALL',
          start_date TIMESTAMPTZ,
          target_date TIMESTAMPTZ,
          daily_new_kanji INT,
          is_active INT NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE user_kanji_learning_plan
        ADD COLUMN IF NOT EXISTS jlpt_level VARCHAR(5) NOT NULL DEFAULT 'ALL';
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_kanji_learning_plan_user_active
        ON user_kanji_learning_plan(user_id, is_active, id DESC);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_kanji_progress (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL,
          kanji_char VARCHAR(8) NOT NULL,
          plan_id BIGINT,
          stage INT NOT NULL DEFAULT 0,
          next_review_date TIMESTAMPTZ,
          last_reviewed_at TIMESTAMPTZ,
          times_reviewed INT NOT NULL DEFAULT 0,
          last_result INT,
          is_mastered INT NOT NULL DEFAULT 0,
          first_seen_date TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_user_kanji_progress_user_char UNIQUE (user_id, kanji_char)
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_kanji_progress_due
        ON user_kanji_progress(user_id, is_mastered, next_review_date, kanji_char);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_kanji_progress_first_seen
        ON user_kanji_progress(user_id, first_seen_date);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_kanji_review_log (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL,
          kanji_char VARCHAR(8) NOT NULL,
          review_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          result INT NOT NULL,
          mode VARCHAR(20) NOT NULL
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_kanji_review_log_user_time
        ON user_kanji_review_log(user_id, review_time DESC);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_kanji_review_log_user_char
        ON user_kanji_review_log(user_id, kanji_char);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_kanji_review_log_user_mode_time
        ON user_kanji_review_log(user_id, mode, review_time DESC);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_kanji_plan_item (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL,
          plan_id BIGINT NOT NULL,
          day_index INT NOT NULL,
          order_in_day INT NOT NULL,
          kanji_char VARCHAR(8) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          first_result INT,
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_user_kanji_plan_item_plan_char UNIQUE (plan_id, kanji_char)
        );
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE user_kanji_plan_item
        ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending';
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE user_kanji_plan_item
        ADD COLUMN IF NOT EXISTS first_result INT;
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE user_kanji_plan_item
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_kanji_plan_item_user_plan_day
        ON user_kanji_plan_item(user_id, plan_id, day_index, order_in_day);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_kanji_plan_item_user_status_day
        ON user_kanji_plan_item(user_id, status, day_index, order_in_day);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_kanji_plan_item_user_char
        ON user_kanji_plan_item(user_id, kanji_char);
      `);
    })().catch((error) => {
      ensureKanjiLearningTablesPromise = null;
      throw error;
    });
  }
  return ensureKanjiLearningTablesPromise;
}

async function getActiveKanjiPlan(userId: number): Promise<KanjiLearningPlan | null> {
  await ensureKanjiLearningTables();
  const rows = await prisma.$queryRawUnsafe<Array<KanjiLearningPlanRow>>(
    `
      SELECT
        id, user_id, total_kanji, target_months, jlpt_level, start_date, target_date, daily_new_kanji, is_active, created_at, updated_at
      FROM user_kanji_learning_plan
      WHERE user_id = $1
        AND is_active = 1
      ORDER BY id DESC
      LIMIT 1
    `,
    BigInt(userId),
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    totalKanji: Number(row.total_kanji || 0),
    targetMonths: Number(row.target_months || 0),
    jlptLevel: normalizeJlptLevel(row.jlpt_level || 'ALL'),
    startDate: row.start_date,
    targetDate: row.target_date,
    dailyNewKanji: Number(row.daily_new_kanji || 0),
    isActive: Number(row.is_active || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getKanjiPlanDayIndex(startDate: Date | null | undefined): number {
  if (!startDate) return 0;
  const start = dateOnly(new Date(startDate));
  const today = dateOnly(new Date());
  const diffMs = today.getTime() - start.getTime();
  const day = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return Math.max(0, day);
}

async function ensureKanjiPlanItemsForPlan(userId: number, plan: KanjiLearningPlan): Promise<void> {
  if (!plan?.id || !plan.dailyNewKanji || plan.dailyNewKanji <= 0) return;
  const [row] = await prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
    `
      SELECT COUNT(*)::bigint AS total
      FROM user_kanji_plan_item
      WHERE user_id = $1
        AND plan_id = $2
    `,
    BigInt(userId),
    BigInt(plan.id),
  );
  const total = Number(row?.total || 0n);
  if (total > 0) return;
  await rebuildKanjiPlanItemsForPlan(userId, plan);
}

async function rebuildKanjiPlanItemsForPlan(userId: number, plan: KanjiLearningPlan): Promise<void> {
  if (!plan?.id || !plan.dailyNewKanji || plan.dailyNewKanji <= 0) return;
  const daily = Math.max(1, Math.floor(plan.dailyNewKanji));
  const level = normalizeJlptLevel(plan.jlptLevel || 'ALL');
  const allowedChars = await getAllowedKanjiChars(level);
  if (!allowedChars.length) return;

  const rows = await pickNewKanjiRowsForUser({
    userId,
    jlptLevel: level,
    limit: allowedChars.length,
  });

  await prisma.$executeRawUnsafe(
    `
      DELETE FROM user_kanji_plan_item
      WHERE user_id = $1
        AND plan_id = $2
    `,
    BigInt(userId),
    BigInt(plan.id),
  );

  if (!rows.length) return;

  const dayIndexes: number[] = [];
  const orderInDays: number[] = [];
  const chars: string[] = [];

  rows.forEach((row, index) => {
    dayIndexes.push(Math.floor(index / daily));
    orderInDays.push((index % daily) + 1);
    chars.push(String(row.kanji_char || '').trim());
  });

  await prisma.$executeRawUnsafe(
    `
      INSERT INTO user_kanji_plan_item (
        user_id, plan_id, day_index, order_in_day, kanji_char, status, created_at, updated_at
      )
      SELECT
        $1,
        $2,
        x.day_index,
        x.order_in_day,
        x.kanji_char,
        'pending',
        NOW(),
        NOW()
      FROM UNNEST($3::int[], $4::int[], $5::text[]) AS x(day_index, order_in_day, kanji_char)
      ON CONFLICT (plan_id, kanji_char)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        day_index = EXCLUDED.day_index,
        order_in_day = EXCLUDED.order_in_day,
        updated_at = NOW()
    `,
    BigInt(userId),
    BigInt(plan.id),
    dayIndexes,
    orderInDays,
    chars,
  );
}

async function listScheduledNewKanjiRows(userId: number, plan: KanjiLearningPlan): Promise<KanjiLearningItemRow[]> {
  if (!plan?.id || !plan.dailyNewKanji || plan.dailyNewKanji <= 0) return [];
  const dayIndex = getKanjiPlanDayIndex(plan.startDate);
  const limit = Math.max(1, Math.floor(plan.dailyNewKanji));

  return prisma.$queryRawUnsafe<Array<KanjiLearningItemRow>>(
    `
      WITH scheduled AS (
        SELECT
          pi.kanji_char,
          pi.day_index,
          pi.order_in_day
        FROM user_kanji_plan_item pi
        WHERE pi.user_id = $1
          AND pi.plan_id = $2
          AND pi.day_index = $3
          AND pi.status = 'pending'
          AND NOT EXISTS (
            SELECT 1
            FROM user_kanji_progress p
            WHERE p.user_id = pi.user_id
              AND p.kanji_char = pi.kanji_char
          )
        ORDER BY pi.day_index ASC, pi.order_in_day ASC, pi.kanji_char ASC
        LIMIT $4
      )
      SELECT
        s.kanji_char,
        ex.word_ja AS example_word_ja,
        ex.reading_kana AS example_reading_kana,
        ex.meaning_vi AS example_meaning_vi,
        ex.meaning_en AS example_meaning_en
      FROM scheduled s
      LEFT JOIN LATERAL (
        SELECT word_ja, reading_kana, meaning_vi, meaning_en
        FROM kanji_compound k2
        WHERE k2.kanji_char = s.kanji_char
        ORDER BY
          CASE WHEN COALESCE(k2.meaning_vi, '') <> '' THEN 0 ELSE 1 END,
          k2.priority ASC,
          k2.word_ja ASC
        LIMIT 1
      ) ex ON TRUE
      ORDER BY s.day_index ASC, s.order_in_day ASC, s.kanji_char ASC
    `,
    BigInt(userId),
    BigInt(plan.id),
    dayIndex,
    limit,
  );
}

function mapKanjiLearningItem(row: KanjiLearningItemRow) {
  return {
    kanji: String(row.kanji_char || '').trim(),
    stage: Number.isFinite(Number(row.stage)) ? Number(row.stage) : 0,
    nextReviewDate: row.next_review_date || null,
    priority: Number.isFinite(Number(row.min_priority)) ? Number(row.min_priority) : null,
    exampleWordJa: String(row.example_word_ja || '').trim(),
    exampleReadingKana: String(row.example_reading_kana || '').trim(),
    exampleMeaningVi: String(row.example_meaning_vi || '').trim(),
    exampleMeaningEn: String(row.example_meaning_en || '').trim(),
  };
}

type KanjiReviewCountRow = {
  total: bigint;
};

type PickNewKanjiRowsArgs = {
  userId: number;
  jlptLevel: JlptLevel;
  limit: number;
};

async function countTodayLearnedKanji(userId: number): Promise<number> {
  const [usedRow] = await prisma.$queryRawUnsafe<Array<KanjiReviewCountRow>>(
    `
      SELECT COUNT(DISTINCT kanji_char) AS total
      FROM user_kanji_review_log
      WHERE user_id = $1
        AND mode = 'new'
        AND review_time >= CURRENT_DATE
        AND review_time < (CURRENT_DATE + INTERVAL '1 day')
    `,
    BigInt(userId),
  );
  return Number(usedRow?.total || 0n);
}

async function listDueKanjiRows(userId: number): Promise<KanjiLearningItemRow[]> {
  return prisma.$queryRawUnsafe<Array<KanjiLearningItemRow>>(
    `
      WITH due AS (
        SELECT kanji_char, stage, next_review_date
        FROM user_kanji_progress
        WHERE user_id = $1
          AND is_mastered = 0
          AND next_review_date <= CURRENT_DATE
        ORDER BY next_review_date ASC, kanji_char ASC
        LIMIT 200
      )
      SELECT
        d.kanji_char,
        d.stage AS stage,
        d.next_review_date AS next_review_date,
        ex.word_ja AS example_word_ja,
        ex.reading_kana AS example_reading_kana,
        ex.meaning_vi AS example_meaning_vi,
        ex.meaning_en AS example_meaning_en
      FROM due d
      LEFT JOIN LATERAL (
        SELECT word_ja, reading_kana, meaning_vi, meaning_en
        FROM kanji_compound k2
        WHERE k2.kanji_char = d.kanji_char
        ORDER BY
          CASE WHEN COALESCE(k2.meaning_vi, '') <> '' THEN 0 ELSE 1 END,
          k2.priority ASC,
          k2.word_ja ASC
        LIMIT 1
      ) ex ON TRUE
      ORDER BY d.next_review_date ASC, d.kanji_char ASC
    `,
    BigInt(userId),
  );
}

async function pickNewKanjiRowsForUser(args: PickNewKanjiRowsArgs): Promise<KanjiLearningItemRow[]> {
  const limit = Math.max(0, Math.floor(args.limit));
  if (limit <= 0) return [];
  const allowedChars = await getAllowedKanjiChars(args.jlptLevel);
  if (allowedChars.length === 0) return [];

  return prisma.$queryRawUnsafe<Array<KanjiLearningItemRow>>(
    `
      WITH allowed AS (
        SELECT UNNEST($2::text[]) AS kanji_char
      ),
      unseen AS (
        SELECT a.kanji_char
        FROM allowed a
        WHERE NOT EXISTS (
          SELECT 1
          FROM user_kanji_progress p
          WHERE p.user_id = $1
            AND p.kanji_char = a.kanji_char
        )
      ),
      ranked AS (
        SELECT DISTINCT ON (kc.kanji_char)
          kc.kanji_char,
          kc.priority AS min_priority
        FROM kanji_compound kc
        INNER JOIN unseen u ON u.kanji_char = kc.kanji_char
        ORDER BY kc.kanji_char ASC, kc.priority ASC
      ),
      limited AS (
        SELECT
          r.kanji_char,
          r.min_priority
        FROM ranked r
        ORDER BY r.min_priority ASC, r.kanji_char ASC
        LIMIT $3
      )
      SELECT
        l.kanji_char,
        l.min_priority,
        ex.word_ja AS example_word_ja,
        ex.reading_kana AS example_reading_kana,
        ex.meaning_vi AS example_meaning_vi,
        ex.meaning_en AS example_meaning_en
      FROM limited l
      LEFT JOIN LATERAL (
        SELECT word_ja, reading_kana, meaning_vi, meaning_en
        FROM kanji_compound k2
        WHERE k2.kanji_char = l.kanji_char
        ORDER BY
          CASE WHEN COALESCE(k2.meaning_vi, '') <> '' THEN 0 ELSE 1 END,
          k2.priority ASC,
          k2.word_ja ASC
        LIMIT 1
      ) ex ON TRUE
      ORDER BY l.min_priority ASC, l.kanji_char ASC
    `,
    BigInt(args.userId),
    allowedChars,
    limit,
  );
}

type KanjiCatalog = {
  all: string[];
  byLevel: Record<JlptLevel, string[]>;
};

let kanjiCatalogPromise: Promise<KanjiCatalog> | null = null;

function normalizeJlptLevel(raw: unknown): JlptLevel {
  const value = String(raw || '').trim().toUpperCase();
  if (value === 'N1' || value === 'N2' || value === 'N3' || value === 'N4' || value === 'N5') {
    return value;
  }
  return 'ALL';
}

async function getAllowedKanjiChars(level: JlptLevel): Promise<string[]> {
  const catalog = await loadKanjiCatalog();
  return catalog.byLevel[level] || [];
}

async function countKanjiByJlptLevel(level: JlptLevel): Promise<number> {
  const allowedChars = await getAllowedKanjiChars(level);
  if (allowedChars.length === 0) return 0;
  const [row] = await prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
    `
      SELECT COUNT(DISTINCT kanji_char) AS total
      FROM kanji_compound
      WHERE kanji_char = ANY($1::text[])
    `,
    allowedChars,
  );
  return Number(row?.total || 0n);
}

async function loadKanjiCatalog(): Promise<KanjiCatalog> {
  if (!kanjiCatalogPromise) {
    kanjiCatalogPromise = (async () => {
      const sourcePath = resolveKanjiCatalogPath();
      if (!sourcePath) {
        return {
          all: [],
          byLevel: {
            ALL: [],
            N5: [],
            N4: [],
            N3: [],
            N2: [],
            N1: [],
          },
        };
      }
      const raw = fs.readFileSync(sourcePath, 'utf8');
      const data = JSON.parse(raw) as Record<string, { jlpt_new?: number }>;
      const allSet = new Set<string>();
      const levelSets: Record<JlptLevel, Set<string>> = {
        ALL: new Set<string>(),
        N5: new Set<string>(),
        N4: new Set<string>(),
        N3: new Set<string>(),
        N2: new Set<string>(),
        N1: new Set<string>(),
      };

      Object.entries(data || {}).forEach(([char, info]) => {
        const ch = String(char || '').trim();
        if (!ch) return;
        allSet.add(ch);
        const jlptNum = Number(info?.jlpt_new);
        if (jlptNum >= 1 && jlptNum <= 5) {
          const level = `N${jlptNum}` as JlptLevel;
          levelSets[level].add(ch);
        }
      });

      const jlptAllSet = new Set<string>();
      ['N5', 'N4', 'N3', 'N2', 'N1'].forEach((level) => {
        levelSets[level as JlptLevel].forEach((ch) => jlptAllSet.add(ch));
      });

      return {
        all: Array.from(allSet),
        byLevel: {
          // "ALL" for learning plan means JLPT N5->N1 union (~2200), not every rare kanji from dictionary dumps.
          ALL: Array.from(jlptAllSet),
          N5: Array.from(levelSets.N5),
          N4: Array.from(levelSets.N4),
          N3: Array.from(levelSets.N3),
          N2: Array.from(levelSets.N2),
          N1: Array.from(levelSets.N1),
        },
      };
    })().catch((error) => {
      kanjiCatalogPromise = null;
      throw error;
    });
  }
  return kanjiCatalogPromise;
}

function resolveKanjiCatalogPath(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../data/kanji/kanji-en.json'),
    path.resolve(process.cwd(), 'data/kanji/kanji-en.json'),
    path.resolve(__dirname, '../../../vocab-frontend/public/data/kanji/kanji-en.json'),
    path.resolve(process.cwd(), '../vocab-frontend/public/data/kanji/kanji-en.json'),
    path.resolve(process.cwd(), 'public/data/kanji/kanji-en.json'),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}
