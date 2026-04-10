import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { dateOnly } from '../lib/http';

type GameMode = 'matrix' | 'falling' | 'flappy' | 'runner';
type Difficulty = 'easy' | 'normal' | 'hard' | 'expert';
type QuestionType = 'kanji_to_vi' | 'vi_to_kanji' | 'kanji_to_reading' | 'reading_to_vi';
type VocabTrack = 'core' | 'book' | 'today';

type VocabCard = {
  id: number;
  word_ja: string | null;
  reading: string | null;
  meaning_vi: string | null;
  example_ja: string | null;
  example_vi: string | null;
  jlpt_level: string | null;
  topic: string | null;
  audio_url: string | null;
};

type SubmitItem = {
  vocabId: number;
  correct: boolean;
  responseMs?: number;
  questionType?: QuestionType;
};

type DeckRequestPayload = {
  userId: number;
  mode: GameMode;
  difficulty: Difficulty;
  questionType: QuestionType;
  track: VocabTrack;
  sourceBook: string | null;
  sourceUnit: string | null;
  topicPrefix: string | null;
  boardSize: number;
  jlptLevels: string[];
};

type SessionSubmitPayload = {
  userId: number;
  mode: GameMode;
  difficulty: Difficulty;
  questionType: QuestionType;
  score: number;
  durationSec: number;
  totalQuestions: number;
  correctCount: number;
  wrongCount: number;
  maxCombo: number;
  boardSize: number;
  timeLimitSec: number;
  items: SubmitItem[];
};

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

type ModeConfig = {
  mode: GameMode;
  timeLimitSec: number;
  lives: number;
  boardSize?: number;
  defaultQuestionType: QuestionType;
};

const ALLOWED_GAME_MODES: GameMode[] = ['matrix', 'falling', 'flappy', 'runner'];
const ALLOWED_DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'expert'];
const ALLOWED_QUESTION_TYPES: QuestionType[] = ['kanji_to_vi', 'vi_to_kanji', 'kanji_to_reading', 'reading_to_vi'];
const ALLOWED_TRACKS: VocabTrack[] = ['core', 'book', 'today'];
const DEFAULT_BOARD_SIZE = 16;
const MAX_DECK_SIZE = 36;
const REVIEW_INTERVALS = [0, 1, 3, 7, 30, 90];
const XP_BY_MODE: Record<GameMode, number> = {
  matrix: 12,
  falling: 14,
  flappy: 16,
  runner: 18,
};
const UNLOCK_XP_BY_MODE: Record<GameMode, number> = {
  matrix: 0,
  falling: 120,
  flappy: 260,
  runner: 420,
};

const BASE_MODE_CONFIGS: Record<GameMode, ModeConfig> = {
  matrix: {
    mode: 'matrix',
    timeLimitSec: 90,
    lives: 3,
    boardSize: 16,
    defaultQuestionType: 'kanji_to_vi',
  },
  falling: {
    mode: 'falling',
    timeLimitSec: 60,
    lives: 3,
    defaultQuestionType: 'kanji_to_vi',
  },
  flappy: {
    mode: 'flappy',
    timeLimitSec: 60,
    lives: 1,
    defaultQuestionType: 'vi_to_kanji',
  },
  runner: {
    mode: 'runner',
    timeLimitSec: 75,
    lives: 3,
    defaultQuestionType: 'kanji_to_vi',
  },
};

let ensureLearningGameTablesPromise: Promise<void> | null = null;

export function createLearningGameRouter() {
  const router = Router();

  router.get('/modes', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });

    await ensureLearningGameTables();
    const profile = await ensureGameProfile(userId);
    const xp = Number(profile.xp || 0);

    return res.json({
      modes: ALLOWED_GAME_MODES.map((mode) => {
        const unlockXp = UNLOCK_XP_BY_MODE[mode];
        return {
          ...BASE_MODE_CONFIGS[mode],
          unlockXp,
          unlocked: xp >= unlockXp,
        };
      }),
    });
  });

  router.get('/profile', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });

    await ensureLearningGameTables();
    const profile = await ensureGameProfile(userId);
    const userBigId = BigInt(userId);

    const [weeklyRow] = await prisma.$queryRaw<Array<{ sessions: bigint; score_avg: number | null; accuracy_avg: number | null }>>`
      SELECT
        COUNT(*)::bigint AS sessions,
        AVG(score)::float8 AS score_avg,
        AVG(accuracy)::float8 AS accuracy_avg
      FROM user_game_session
      WHERE user_id = ${userBigId}
        AND played_at >= NOW() - INTERVAL '7 days'
    `;

    const [stateRow] = await prisma.$queryRaw<Array<{
      learned: bigint;
      mastered: bigint;
      learning: bigint;
      familiar: bigint;
    }>>`
      SELECT
        COUNT(*)::bigint AS learned,
        COUNT(*) FILTER (WHERE is_mastered = 1)::bigint AS mastered,
        COUNT(*) FILTER (WHERE is_mastered = 0 AND stage <= 1)::bigint AS learning,
        COUNT(*) FILTER (WHERE is_mastered = 0 AND stage BETWEEN 2 AND 4)::bigint AS familiar
      FROM user_vocab_progress
      WHERE user_id = ${userBigId}
    `;

    const weakWords = await listWeakWords(userId, 10);

    return res.json({
      xp: Number(profile.xp || 0),
      totalGames: Number(profile.total_games || 0),
      currentStreak: Number(profile.current_streak || 0),
      longestStreak: Number(profile.longest_streak || 0),
      lastPlayedDate: profile.last_played_date,
      weekly: {
        sessions: Number(weeklyRow?.sessions || 0n),
        avgScore: Number(weeklyRow?.score_avg || 0),
        avgAccuracy: Number(weeklyRow?.accuracy_avg || 0),
      },
      vocabState: {
        new: 0,
        learned: Number(stateRow?.learned || 0n),
        learning: Number(stateRow?.learning || 0n),
        familiar: Number(stateRow?.familiar || 0n),
        mastered: Number(stateRow?.mastered || 0n),
        weak: weakWords.length,
      },
      weakWords,
    });
  });

  router.get('/weak-words', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    const limit = Math.max(1, Math.min(Number(req.query.limit || 20), 100));
    if (!Number.isFinite(userId)) return res.status(400).json({ message: 'Invalid userId' });
    return res.json({ items: await listWeakWords(userId, limit) });
  });

  router.post('/deck', async (req: Request, res: Response) => {
    const payload = validateDeckRequest(req.body);
    if (!payload.ok) return res.status(400).json({ message: payload.message });

    try {
      const deckPayload = await generateDeckPayload(payload.value);
      return res.json(deckPayload);
    } catch (error) {
      const status = (error as { status?: number })?.status || 500;
      const message = (error as { message?: string })?.message || 'Cannot generate deck';
      return res.status(status).json({ message });
    }
  });

  router.post('/session/submit', async (req: Request, res: Response) => {
    const payload = validateSessionSubmitRequest(req.body);
    if (!payload.ok) return res.status(400).json({ message: payload.message });

    const result = await submitGameSession(payload.value);
    return res.json(result);
  });

  return router;
}

function validateDeckRequest(body: unknown): ValidationResult<DeckRequestPayload> {
  const payload = body as Record<string, unknown> | null | undefined;
  const userId = Number(payload?.userId);
  if (!Number.isFinite(userId) || userId <= 0) return { ok: false, message: 'Invalid userId' };

  const mode = normalizeGameMode(payload?.mode);
  const difficulty = normalizeDifficulty(payload?.difficulty);
  const questionType = normalizeQuestionType(payload?.questionType, BASE_MODE_CONFIGS[mode].defaultQuestionType);
  const track = normalizeTrack(payload?.track);
  const sourceBook = cleanText(payload?.sourceBook);
  const sourceUnit = cleanText(payload?.sourceUnit);
  const topicPrefix = cleanText(payload?.topicPrefix);
  const boardSize = normalizeBoardSize(Number(payload?.size || payload?.boardSize || DEFAULT_BOARD_SIZE));
  const jlptLevels = normalizeJlptLevels(payload?.jlptLevels);

  if (track === 'book' && !sourceBook) {
    return { ok: false, message: 'sourceBook is required when track=book' };
  }

  return {
    ok: true,
    value: {
      userId,
      mode,
      difficulty,
      questionType,
      track,
      sourceBook,
      sourceUnit,
      topicPrefix,
      boardSize,
      jlptLevels,
    },
  };
}

async function generateDeckPayload(input: DeckRequestPayload) {
  const needsPairCount =
    input.mode === 'matrix'
      ? Math.max(2, Math.floor(input.boardSize / 2))
      : Math.max(8, input.boardSize);
  const candidateTake = Math.max(needsPairCount * 8, 120);
  const candidates = await listDeckCandidates(input, candidateTake);

  const cards = candidates.map((row) => mapVocabCard(row));
  let effectiveQuestionType = input.questionType;
  let filtered = filterByQuestionType(cards, effectiveQuestionType);

  if (!filtered.length) {
    const fallbackQuestionType = BASE_MODE_CONFIGS[input.mode].defaultQuestionType;
    if (fallbackQuestionType !== effectiveQuestionType) {
      const fallbackFiltered = filterByQuestionType(cards, fallbackQuestionType);
      if (fallbackFiltered.length) {
        filtered = fallbackFiltered;
        effectiveQuestionType = fallbackQuestionType;
      }
    }
  }

  if (!filtered.length) {
    throw Object.assign(new Error('Khong co du tu on tap hom nay phu hop voi kieu cau hoi nay'), { status: 400 });
  }

  const weakIds = await listWeakVocabIds(input.userId, 60);
  const selected = pickPrioritizedWords(filtered, weakIds, needsPairCount);
  const result =
    input.mode === 'matrix'
      ? buildMatrixDeck(selected, effectiveQuestionType, input.boardSize)
      : buildArcadeDeck(selected, filtered, effectiveQuestionType, input.boardSize, input.difficulty, input.mode);

  return {
    mode: input.mode,
    difficulty: input.difficulty,
    questionType: effectiveQuestionType,
    boardSize: input.boardSize,
    weakPriorityApplied: weakIds.length > 0,
    ...result,
  };
}

async function listDeckCandidates(input: DeckRequestPayload, candidateTake: number) {
  if (input.track === 'today') {
    const dueRows = await prisma.$queryRaw<Array<{ vocab_id: bigint }>>`
      SELECT vocab_id
      FROM user_vocab_progress
      WHERE user_id = ${BigInt(input.userId)}
        AND is_mastered = 0
        AND next_review_date <= CURRENT_DATE
      ORDER BY next_review_date ASC, vocab_id ASC
      LIMIT ${Math.min(candidateTake, 500)}
    `;

    const dueIds = dueRows.map((row) => row.vocab_id);
    if (!dueIds.length) {
      throw Object.assign(new Error('Khong co tu on tap hom nay'), { status: 400 });
    }

    return prisma.vocabulary.findMany({
      where: {
        id: { in: dueIds },
        ...(input.jlptLevels.length ? { level: { in: input.jlptLevels } } : {}),
      } as Prisma.VocabularyWhereInput,
      orderBy: [{ id: 'asc' }],
      take: Math.min(candidateTake, 2000),
      select: {
        id: true,
        word_ja: true,
        word_hira_kana: true,
        word_vi: true,
        example_ja: true,
        example_vi: true,
        level: true,
        topic: true,
        audio_url: true,
      },
    });
  }

  const where = buildVocabWhere({
    track: input.track,
    sourceBook: input.sourceBook,
    sourceUnit: input.sourceUnit,
    topicPrefix: input.topicPrefix,
    jlptLevels: input.jlptLevels,
  });

  return prisma.vocabulary.findMany({
    where: where as Prisma.VocabularyWhereInput,
    orderBy: [{ id: 'asc' }],
    take: Math.min(candidateTake, 2000),
    select: {
      id: true,
      word_ja: true,
      word_hira_kana: true,
      word_vi: true,
      example_ja: true,
      example_vi: true,
      level: true,
      topic: true,
      audio_url: true,
    },
  });
}

function validateSessionSubmitRequest(body: unknown): ValidationResult<SessionSubmitPayload> {
  const payload = body as Record<string, unknown> | null | undefined;
  const userId = Number(payload?.userId);
  if (!Number.isFinite(userId) || userId <= 0) return { ok: false, message: 'Invalid userId' };

  const mode = normalizeGameMode(payload?.mode);
  const difficulty = normalizeDifficulty(payload?.difficulty);
  const questionType = normalizeQuestionType(payload?.questionType, BASE_MODE_CONFIGS[mode].defaultQuestionType);
  const score = Math.max(0, Number(payload?.score || 0));
  const durationSec = Math.max(0, Math.floor(Number(payload?.durationSec || 0)));
  const totalQuestions = Math.max(0, Math.floor(Number(payload?.totalQuestions || 0)));
  const correctCount = Math.max(0, Math.floor(Number(payload?.correctCount || 0)));
  const wrongCount = Math.max(0, Math.floor(Number(payload?.wrongCount || 0)));
  const maxCombo = Math.max(0, Math.floor(Number(payload?.maxCombo || 0)));
  const boardSize = Math.max(0, Math.floor(Number(payload?.boardSize || 0)));
  const timeLimitSec = Math.max(0, Math.floor(Number(payload?.timeLimitSec || 0)));

  if (correctCount + wrongCount > totalQuestions && totalQuestions > 0) {
    return { ok: false, message: 'correctCount + wrongCount cannot exceed totalQuestions' };
  }

  const rawItems: unknown[] = Array.isArray(payload?.items) ? (payload?.items as unknown[]) : [];
  const items: SubmitItem[] = rawItems
    .map((item: unknown) => normalizeSubmitItem(item))
    .filter((item: SubmitItem | null): item is SubmitItem => Boolean(item));
  // Keep session submit resilient for client/runtime edge cases (e.g. runner ended before answer event).
  // When items is empty/invalid, still accept session stats and skip SRS item updates.

  return {
    ok: true,
    value: {
      userId,
      mode,
      difficulty,
      questionType,
      score,
      durationSec,
      totalQuestions,
      correctCount,
      wrongCount,
      maxCombo,
      boardSize,
      timeLimitSec,
      items,
    },
  };
}

async function submitGameSession(input: SessionSubmitPayload) {
  await ensureLearningGameTables();
  const userBigId = BigInt(input.userId);
  const now = new Date();
  const accuracy = input.totalQuestions > 0 ? (input.correctCount * 100) / input.totalQuestions : 0;
  const profileBefore = await ensureGameProfile(input.userId);
  const activePlan = await prisma.userLearningPlan.findFirst({
    where: { user_id: userBigId, is_active: 1 },
    orderBy: { id: 'desc' },
    select: { id: true },
  });

  const session = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(
    `
      INSERT INTO user_game_session (
        user_id, mode, difficulty, question_type, score, accuracy, duration_sec, total_questions, correct_count, wrong_count, max_combo, config_json, result_json, played_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, NOW())
      RETURNING id
    `,
    userBigId,
    input.mode,
    input.difficulty,
    input.questionType,
    Math.round(input.score),
    Number(accuracy.toFixed(2)),
    input.durationSec,
    input.totalQuestions,
    input.correctCount,
    input.wrongCount,
    input.maxCombo,
    JSON.stringify({
      mode: input.mode,
      difficulty: input.difficulty,
      questionType: input.questionType,
      boardSize: input.boardSize,
      timeLimitSec: input.timeLimitSec,
    }),
    JSON.stringify({
      score: input.score,
      accuracy: Number(accuracy.toFixed(2)),
      totalQuestions: input.totalQuestions,
      correctCount: input.correctCount,
      wrongCount: input.wrongCount,
      maxCombo: input.maxCombo,
    }),
  );

  // SRS update: answer đúng tăng stage, sai giảm stage và dời lịch ôn theo REVIEW_INTERVALS.
  for (const item of input.items) {
    await applyLearningReview({
      userId: input.userId,
      userBigId,
      vocabId: item.vocabId,
      correct: item.correct,
      mode: `game:${input.mode}`,
      at: now,
      planId: activePlan?.id || null,
    });
  }

  // XP formula keeps mode bonus and rewards speed/accuracy while ensuring minimum +5 XP.
  const gainedXp = Math.max(
    5,
    Math.round(
      input.correctCount * 2 +
      (accuracy >= 80 ? 10 : 0) +
      (input.score / 20) +
      XP_BY_MODE[input.mode],
    ),
  );
  const streakUpdate = computeStreakUpdate(
    profileBefore.last_played_date,
    Number(profileBefore.current_streak || 0),
  );

  await prisma.$executeRawUnsafe(
    `
      UPDATE user_game_profile
      SET
        xp = xp + $2,
        total_games = total_games + 1,
        current_streak = $3,
        longest_streak = GREATEST(longest_streak, $3),
        last_played_date = $4,
        updated_at = NOW()
      WHERE user_id = $1
    `,
    userBigId,
    gainedXp,
    streakUpdate.currentStreak,
    streakUpdate.lastPlayedDate,
  );

  const weakWords = await listWeakWords(input.userId, 8);
  return {
    sessionId: Number(session?.[0]?.id || 0n),
    gainedXp,
    streak: streakUpdate.currentStreak,
    weakWords,
    replayPack: weakWords.map((item) => item.id),
  };
}

function normalizeGameMode(value: unknown): GameMode {
  const mode = String(value || 'matrix').trim().toLowerCase() as GameMode;
  return ALLOWED_GAME_MODES.includes(mode) ? mode : 'matrix';
}

function normalizeDifficulty(value: unknown): Difficulty {
  const difficulty = String(value || 'easy').trim().toLowerCase() as Difficulty;
  return ALLOWED_DIFFICULTIES.includes(difficulty) ? difficulty : 'easy';
}

function normalizeQuestionType(value: unknown, fallback: QuestionType): QuestionType {
  const questionType = String(value || fallback).trim().toLowerCase() as QuestionType;
  return ALLOWED_QUESTION_TYPES.includes(questionType) ? questionType : fallback;
}

function normalizeTrack(value: unknown): VocabTrack {
  const track = String(value || 'core').trim().toLowerCase() as VocabTrack;
  return ALLOWED_TRACKS.includes(track) ? track : 'core';
}

function normalizeBoardSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BOARD_SIZE;
  const normalized = Math.max(8, Math.min(MAX_DECK_SIZE, Math.floor(value)));
  return normalized % 2 === 0 ? normalized : normalized - 1;
}

function cleanText(value: unknown): string | null {
  const text = String(value || '').trim();
  return text.length ? text : null;
}

function normalizeJlptLevels(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((item) => String(item || '').trim().toUpperCase())
    .filter((item) => /^N[1-5]$/.test(item));
}

function mapVocabCard(row: {
  id: bigint;
  word_ja: string | null;
  word_hira_kana: string | null;
  word_vi: string | null;
  example_ja: string | null;
  example_vi: string | null;
  level: string | null;
  topic: string | null;
  audio_url: string | null;
}): VocabCard {
  return {
    id: Number(row.id),
    word_ja: row.word_ja,
    reading: row.word_hira_kana,
    meaning_vi: row.word_vi,
    example_ja: row.example_ja,
    example_vi: row.example_vi,
    jlpt_level: row.level,
    topic: row.topic,
    audio_url: row.audio_url,
  };
}

function filterByQuestionType(items: VocabCard[], questionType: QuestionType): VocabCard[] {
  return items.filter((item) => {
    const prompt = getPromptText(item, questionType);
    const answer = getAnswerText(item, questionType);
    return Boolean(prompt && answer);
  });
}

function pickPrioritizedWords(items: VocabCard[], weakIds: number[], needed: number): VocabCard[] {
  const shuffled = shuffle(items);
  const weakSet = new Set(weakIds);
  const weakItems = shuffled.filter((item) => weakSet.has(item.id));
  const normalItems = shuffled.filter((item) => !weakSet.has(item.id));
  return [...weakItems, ...normalItems].slice(0, needed);
}

function buildMatrixDeck(items: VocabCard[], questionType: QuestionType, boardSize: number) {
  const pairCount = Math.max(2, Math.min(items.length, Math.floor(boardSize / 2)));
  const pairs = items.slice(0, pairCount).map((item, index) => ({
    pairId: `${item.id}-${index}`,
    vocabId: item.id,
    left: getPromptText(item, questionType),
    right: getAnswerText(item, questionType),
    item,
  }));

  const cards = shuffle(
    pairs.flatMap((pair) => [
      {
        cardId: `${pair.pairId}-L`,
        pairId: pair.pairId,
        vocabId: pair.vocabId,
        side: 'left',
        text: pair.left,
      },
      {
        cardId: `${pair.pairId}-R`,
        pairId: pair.pairId,
        vocabId: pair.vocabId,
        side: 'right',
        text: pair.right,
      },
    ]),
  );

  return {
    items: pairs.map((pair) => pair.item),
    matrix: {
      pairCount,
      cards,
    },
  };
}

function buildArcadeDeck(
  items: VocabCard[],
  answerPoolSource: VocabCard[],
  questionType: QuestionType,
  boardSize: number,
  difficulty: Difficulty,
  mode: GameMode,
) {
  const count = Math.max(8, Math.min(items.length, boardSize));
  const selected = items.slice(0, count);
  const poolByAnswer = Array.from(
    new Set(answerPoolSource.map((item) => getAnswerText(item, questionType)).filter((text) => String(text || '').trim().length > 0)),
  );
  if (mode === 'runner' && poolByAnswer.length < 3) {
    throw Object.assign(new Error('Chưa đủ dữ liệu đa dạng để chơi Runner 3 làn. Vui lòng ôn thêm từ hoặc đổi track.'), {
      status: 400,
    });
  }
  const speed = resolveArcadeSpeedMultiplier(mode, difficulty);

  const questions = selected.map((item, index) => {
    const correct = getAnswerText(item, questionType);
    const options = buildOptions(correct, poolByAnswer, 4);
    return {
      qid: index + 1,
      vocabId: item.id,
      prompt: getPromptText(item, questionType),
      promptReading: getPromptReadingText(item, questionType),
      correct,
      options,
    };
  });

  return {
    items: selected,
    gameplay: {
      speedMultiplier: speed,
      lives: difficulty === 'easy' ? 4 : 3,
      questions,
    },
  };
}

function resolveArcadeSpeedMultiplier(mode: GameMode, difficulty: Difficulty): number {
  if (mode === 'runner') {
    if (difficulty === 'easy') return 0.65;
    if (difficulty === 'normal') return 0.82;
    if (difficulty === 'hard') return 1.0;
    return 1.16;
  }
  return difficulty === 'easy' ? 1 : difficulty === 'normal' ? 1.15 : difficulty === 'hard' ? 1.3 : 1.45;
}

function getPromptReadingText(item: VocabCard, questionType: QuestionType): string {
  if ((questionType === 'kanji_to_vi' || questionType === 'kanji_to_reading') && item.word_ja && item.reading) {
    return String(item.reading || '');
  }
  return '';
}

function buildOptions(correct: string, pool: string[], needed: number): string[] {
  const candidates = shuffle(pool.filter((item) => item !== correct));
  const options = [correct, ...candidates.slice(0, Math.max(0, needed - 1))];
  return shuffle([...new Set(options)]).slice(0, needed);
}

function getPromptText(item: VocabCard, questionType: QuestionType): string {
  if (questionType === 'kanji_to_vi') return String(item.word_ja || '');
  if (questionType === 'vi_to_kanji') return String(item.meaning_vi || '');
  if (questionType === 'kanji_to_reading') return String(item.word_ja || '');
  return String(item.reading || '');
}

function getAnswerText(item: VocabCard, questionType: QuestionType): string {
  if (questionType === 'kanji_to_vi') return String(item.meaning_vi || '');
  if (questionType === 'vi_to_kanji') return String(item.word_ja || '');
  if (questionType === 'kanji_to_reading') return String(item.reading || '');
  return String(item.meaning_vi || '');
}

function shuffle<T>(arr: T[]): T[] {
  const list = [...arr];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function buildVocabWhere(args: {
  track: VocabTrack;
  sourceBook: string | null;
  sourceUnit: string | null;
  topicPrefix: string | null;
  jlptLevels: string[];
}): Prisma.VocabularyWhereInput {
  const where: Prisma.VocabularyWhereInput = {
    track: args.track === 'today' ? 'core' : args.track,
  };

  if (args.track === 'core' || args.track === 'today') {
    if (args.topicPrefix) {
      where.topic = { startsWith: args.topicPrefix };
    } else {
      where.core_order = { not: null };
    }
  } else {
    if (args.sourceBook) where.source_book = args.sourceBook;
    if (args.sourceUnit) where.source_unit = args.sourceUnit;
  }

  if (args.jlptLevels.length) {
    where.level = { in: args.jlptLevels };
  }

  return where;
}

function normalizeSubmitItem(raw: unknown): SubmitItem | null {
  const item = raw as Partial<SubmitItem> | null | undefined;
  const vocabId = Number(item?.vocabId);
  if (!Number.isFinite(vocabId)) return null;
  return {
    vocabId,
    correct: Boolean(item?.correct),
    responseMs: Number.isFinite(Number(item?.responseMs)) ? Number(item?.responseMs) : undefined,
    questionType: normalizeQuestionType(item?.questionType, 'kanji_to_vi'),
  };
}

function computeStreakUpdate(
  lastPlayedDate: Date | string | null,
  previousStreak: number,
): {
  currentStreak: number;
  lastPlayedDate: Date;
} {
  const today = dateOnly(new Date());
  const last = lastPlayedDate ? dateOnly(new Date(lastPlayedDate)) : null;
  if (!last) {
    return { currentStreak: 1, lastPlayedDate: today };
  }
  const diffDays = Math.round((today.getTime() - last.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) return { currentStreak: Math.max(previousStreak, 1), lastPlayedDate: today };
  if (diffDays === 1) return { currentStreak: Math.max(previousStreak, 0) + 1, lastPlayedDate: today };
  return { currentStreak: 1, lastPlayedDate: today };
}

async function applyLearningReview(args: {
  userId: number;
  userBigId: bigint;
  vocabId: number;
  correct: boolean;
  mode: string;
  at: Date;
  planId: bigint | null;
}) {
  const existing = await prisma.userVocabProgress.findUnique({
    where: {
      user_id_vocab_id: {
        user_id: args.userBigId,
        vocab_id: BigInt(args.vocabId),
      },
    },
  });

  const baseStage = existing?.stage ?? 0;
  const nextStage = args.correct ? Math.min(baseStage + 1, 5) : Math.max(baseStage - 1, 0);
  const nextReview = new Date(args.at);
  nextReview.setDate(nextReview.getDate() + REVIEW_INTERVALS[nextStage]);
  const firstSeen = existing?.first_seen_date || dateOnly(args.at);

  if (!existing) {
    await prisma.userVocabProgress.create({
      data: {
        user_id: args.userBigId,
        vocab_id: BigInt(args.vocabId),
        plan_id: args.planId,
        stage: nextStage,
        next_review_date: nextReview,
        last_reviewed_at: args.at,
        times_reviewed: 1,
        last_result: args.correct ? 1 : 0,
        is_mastered: nextStage >= 5 ? 1 : 0,
        first_seen_date: firstSeen,
      },
    });
  } else {
    await prisma.userVocabProgress.update({
      where: { id: existing.id },
      data: {
        plan_id: existing.plan_id || args.planId,
        stage: nextStage,
        next_review_date: nextReview,
        last_reviewed_at: args.at,
        times_reviewed: (existing.times_reviewed || 0) + 1,
        last_result: args.correct ? 1 : 0,
        is_mastered: nextStage >= 5 ? 1 : existing.is_mastered,
        first_seen_date: firstSeen,
      },
    });
  }

  await prisma.userReviewLog.create({
    data: {
      user_id: args.userBigId,
      vocab_id: BigInt(args.vocabId),
      review_time: args.at,
      result: args.correct ? 1 : 0,
      mode: args.mode,
    },
  });
}

async function listWeakVocabIds(userId: number, limit: number): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ vocab_id: bigint; wrong_count: bigint; correct_count: bigint }>>`
    SELECT
      vocab_id,
      COUNT(*) FILTER (WHERE result = 0)::bigint AS wrong_count,
      COUNT(*) FILTER (WHERE result = 1)::bigint AS correct_count
    FROM user_review_log
    WHERE user_id = ${BigInt(userId)}
      AND review_time >= NOW() - INTERVAL '30 days'
    GROUP BY vocab_id
    HAVING COUNT(*) FILTER (WHERE result = 0) >= 2
    ORDER BY
      (COUNT(*) FILTER (WHERE result = 0) - COUNT(*) FILTER (WHERE result = 1)) DESC,
      COUNT(*) FILTER (WHERE result = 0) DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => Number(row.vocab_id));
}

async function listWeakWords(userId: number, limit: number) {
  const weakIds = await listWeakVocabIds(userId, limit);
  if (!weakIds.length) return [];

  const words = await prisma.vocabulary.findMany({
    where: { id: { in: weakIds.map((id) => BigInt(id)) } },
    select: {
      id: true,
      word_ja: true,
      word_hira_kana: true,
      word_vi: true,
      level: true,
      topic: true,
    },
  });

  const weakOrder = new Map(weakIds.map((id, index) => [id, index]));
  return words
    .map((row) => ({
      id: Number(row.id),
      wordJa: row.word_ja,
      reading: row.word_hira_kana,
      meaningVi: row.word_vi,
      jlptLevel: row.level,
      topic: row.topic,
    }))
    .sort((a, b) => (weakOrder.get(a.id) || 0) - (weakOrder.get(b.id) || 0));
}

async function ensureGameProfile(userId: number) {
  const userBigId = BigInt(userId);
  const [existing] = await prisma.$queryRaw<Array<{
    user_id: bigint;
    xp: number;
    total_games: number;
    current_streak: number;
    longest_streak: number;
    last_played_date: Date | null;
  }>>`
    SELECT user_id, xp, total_games, current_streak, longest_streak, last_played_date
    FROM user_game_profile
    WHERE user_id = ${userBigId}
    LIMIT 1
  `;

  if (existing) return existing;

  await prisma.$executeRawUnsafe(
    `
      INSERT INTO user_game_profile (user_id, xp, total_games, current_streak, longest_streak, last_played_date, created_at, updated_at)
      VALUES ($1, 0, 0, 0, 0, NULL, NOW(), NOW())
      ON CONFLICT (user_id) DO NOTHING
    `,
    userBigId,
  );

  const [created] = await prisma.$queryRaw<Array<{
    user_id: bigint;
    xp: number;
    total_games: number;
    current_streak: number;
    longest_streak: number;
    last_played_date: Date | null;
  }>>`
    SELECT user_id, xp, total_games, current_streak, longest_streak, last_played_date
    FROM user_game_profile
    WHERE user_id = ${userBigId}
    LIMIT 1
  `;

  return created;
}

async function ensureLearningGameTables() {
  if (!ensureLearningGameTablesPromise) {
    ensureLearningGameTablesPromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_game_profile (
          user_id BIGINT PRIMARY KEY REFERENCES useraccount(id) ON DELETE CASCADE,
          xp INTEGER NOT NULL DEFAULT 0,
          total_games INTEGER NOT NULL DEFAULT 0,
          current_streak INTEGER NOT NULL DEFAULT 0,
          longest_streak INTEGER NOT NULL DEFAULT 0,
          last_played_date DATE NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_game_session (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES useraccount(id) ON DELETE CASCADE,
          mode VARCHAR(20) NOT NULL,
          difficulty VARCHAR(20) NULL,
          question_type VARCHAR(40) NULL,
          score INTEGER NOT NULL DEFAULT 0,
          accuracy NUMERIC(5,2) NOT NULL DEFAULT 0,
          duration_sec INTEGER NOT NULL DEFAULT 0,
          total_questions INTEGER NOT NULL DEFAULT 0,
          correct_count INTEGER NOT NULL DEFAULT 0,
          wrong_count INTEGER NOT NULL DEFAULT 0,
          max_combo INTEGER NOT NULL DEFAULT 0,
          config_json JSONB NULL,
          result_json JSONB NULL,
          played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_game_session_user_played
        ON user_game_session (user_id, played_at DESC)
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_game_session_mode_played
        ON user_game_session (mode, played_at DESC)
      `);
    })().catch((error) => {
      ensureLearningGameTablesPromise = null;
      throw error;
    });
  }
  await ensureLearningGameTablesPromise;
}
