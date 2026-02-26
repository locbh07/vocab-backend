import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { createHash } from 'crypto';
import {
  generateExamQuestionExplanation,
  generatePassageExplanation,
  ExamQuestionExplanation,
  PassageExplanation,
  ReadingSeedQuestionData,
} from '../lib/examExplanation';
import { describeJlptQuestionType, inferJlptQuestionMeta, JlptQuestionType } from '../lib/jlptQuestionType';
import { getOrCreateQuestionReadingCache, QuestionReadingCache } from '../lib/examReadingCache';
import { getExamQuestionMeta, upsertExamQuestionMetaForPart } from '../lib/examQuestionMeta';

const EXPLANATION_PROMPT_VERSION = 14;
let ensureExplainTablePromise: Promise<void> | null = null;

type VerifyRequest = {
  userId: number;
  code: string;
};

type SubmitRequest = {
  userId: number;
  level: string;
  examId: string;
  durationSec?: number;
  code?: string;
  answers?: Record<string, string[]>;
};

type ExplainQuestionRequest = {
  userId: number;
  level: string;
  examId: string;
  part: number;
  sectionIndex: number;
  questionIndex: number;
  code?: string;
  forceRefresh?: boolean;
};

type ExplainPassageRequest = {
  userId: number;
  level: string;
  examId: string;
  part: number;
  sectionIndex: number;
  questionIndexes: number[];
  code?: string;
  forceRefresh?: boolean;
};

type ScoredItem = {
  part: number;
  section_index: number;
  question_index: number;
  question_id: string | null;
  selected: string | null;
  correct_answer: string | null;
  is_correct: boolean;
  question_json: unknown;
};

export function createExamRouter() {
  const router = Router();

  router.post('/verify-code', async (req: Request, res: Response) => {
    const body = req.body as VerifyRequest;
    if (!body?.userId || !body?.code) {
      return res.json({ allowed: false, message: 'Missing userId or code' });
    }
    try {
      const levels = await requireExamAccess(body.userId, body.code, null);
      return res.json({ allowed: true, message: 'OK', levels });
    } catch (error) {
      return res.status((error as { status?: number }).status || 403).json({
        allowed: false,
        message: (error as Error).message,
      });
    }
  });

  router.get('/list', async (req: Request, res: Response) => {
    const level = String(req.query.level || '');
    const userId = Number(req.query.userId);
    const code = String(req.query.code || '');
    try {
      await requireExamAccess(userId, code, level);
      const rows = await prisma.$queryRaw<Array<{ exam_id: string }>>`
        SELECT DISTINCT exam_id
        FROM jlpt_exam
        WHERE level = ${level}
        ORDER BY exam_id DESC
      `;
      return res.json({ level, exams: rows.map((r: { exam_id: string }) => r.exam_id) });
    } catch (error) {
      return res.status((error as { status?: number }).status || 403).json({ message: (error as Error).message });
    }
  });

  router.get('/:level/:examId', async (req: Request, res: Response) => {
    const level = String(req.params.level);
    const examId = String(req.params.examId);
    const userId = Number(req.query.userId);
    const code = String(req.query.code || '');
    try {
      await requireExamAccess(userId, code, level);
      const parts = await prisma.jlptExam.findMany({
        where: { level, exam_id: examId },
        orderBy: { part: 'asc' },
      });
      if (!parts.length) return res.status(404).json({ message: 'Exam not found' });
      const map = new Map<number, unknown>();
      for (const part of parts) {
        map.set(part.part, part.json_data);
      }
      return res.json({
        level,
        examId,
        part1: map.get(1) || null,
        part2: map.get(2) || null,
        part3: map.get(3) || null,
      });
    } catch (error) {
      return res.status((error as { status?: number }).status || 403).json({ message: (error as Error).message });
    }
  });

  router.post('/submit', async (req: Request, res: Response) => {
    const body = req.body as SubmitRequest;
    if (!body?.userId || !body?.level || !body?.examId) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    try {
      await requireExamAccess(body.userId, body.code || '', body.level);
      const parts = await prisma.jlptExam.findMany({
        where: { level: body.level, exam_id: body.examId },
        orderBy: { part: 'asc' },
      });
      if (!parts.length) return res.status(404).json({ message: 'Exam not found' });

      const scored = scoreAttempt(parts, body.answers || {});
      const finished = new Date();
      const durationSec = Number(body.durationSec || 0);
      const started = durationSec > 0 ? new Date(finished.getTime() - durationSec * 1000) : finished;

      const attempt = await prisma.jlptAttempt.create({
        data: {
          user_id: BigInt(body.userId),
          level: body.level,
          exam_id: body.examId,
          started_at: started,
          finished_at: finished,
          duration_sec: durationSec || null,
          score_total: scored.scoreTotal,
          score_sec1: scored.scoreSec1,
          score_sec2: scored.scoreSec2,
          score_sec3: scored.scoreSec3,
        },
      });

      for (const item of scored.items) {
        await prisma.jlptAttemptItem.create({
          data: {
            attempt_id: attempt.id,
            part: item.part,
            section_index: item.section_index,
            question_index: item.question_index,
            question_id: item.question_id,
            selected: item.selected,
            correct_answer: item.correct_answer,
            is_correct: item.is_correct,
            question_json: item.question_json as any,
          },
        });
      }

      return res.json({
        attemptId: Number(attempt.id),
        scoreTotal: scored.scoreTotal,
        scoreSec1: scored.scoreSec1,
        scoreSec2: scored.scoreSec2,
        scoreSec3: scored.scoreSec3,
        items: scored.items,
      });
    } catch (error) {
      return res.status((error as { status?: number }).status || 500).json({ message: (error as Error).message });
    }
  });

  router.post('/question-explanation', async (req: Request, res: Response) => {
    const body = req.body as ExplainQuestionRequest;
    if (
      !body?.userId ||
      !body?.level ||
      !body?.examId ||
      !Number.isInteger(Number(body.part)) ||
      !Number.isInteger(Number(body.sectionIndex)) ||
      !Number.isInteger(Number(body.questionIndex))
    ) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const part = Number(body.part);
    const sectionIndex = Number(body.sectionIndex);
    const questionIndex = Number(body.questionIndex);
    const forceRefresh = Boolean(body.forceRefresh);
    if (![1, 2, 3].includes(part)) {
      return res.status(400).json({ message: 'Invalid part' });
    }
    if (sectionIndex < 0 || questionIndex < 0) {
      return res.status(400).json({ message: 'Invalid sectionIndex/questionIndex' });
    }

    try {
      await requireExamAccess(body.userId, body.code || '', body.level);
      await ensureQuestionExplanationTable();
      const user = await prisma.userAccount.findUnique({
        where: { id: BigInt(body.userId) },
        select: { role: true },
      });
      const isAdmin = String(user?.role || '').toUpperCase() === 'ADMIN';
      if (forceRefresh && !isAdmin) {
        return res.status(403).json({ message: 'Only admin can refresh explanation' });
      }

      const questionCtx = await loadQuestionContext(
        body.level,
        body.examId,
        part,
        sectionIndex,
        questionIndex,
      );
      const readingCache = await getOrCreateQuestionReadingCache({
        level: body.level,
        examId: body.examId,
        part,
        sectionIndex,
        questionIndex,
        questionText: questionCtx.questionText,
        options: questionCtx.options,
        passageText: questionCtx.passageText,
      });

      const questionHash = buildQuestionHash(questionCtx);
      if (!forceRefresh) {
        const cached = await findCachedExplanation({
          level: body.level,
          examId: body.examId,
          part,
          sectionIndex,
          questionIndex,
          questionHash,
        });
        if (cached) {
          const hydrated = hydrateQuestionExplanationWithReadingCache(cached.explanation, readingCache);
          return res.json({
            source: 'cache',
            promptVersion: EXPLANATION_PROMPT_VERSION,
            explanation: hydrated,
            model: cached.sourceModel,
          });
        }
      }

      if (!isAdmin) {
        const canGenerate = await consumeNonAdminExplanationQuota({
          userId: body.userId,
          level: body.level,
          examId: body.examId,
          part,
          sectionIndex,
          questionIndex,
        });
        if (!canGenerate) {
          const cached = await findCachedExplanation({
            level: body.level,
            examId: body.examId,
            part,
            sectionIndex,
            questionIndex,
            questionHash,
          });
          if (cached) {
            const hydrated = hydrateQuestionExplanationWithReadingCache(cached.explanation, readingCache);
            return res.json({
              source: 'cache',
              promptVersion: EXPLANATION_PROMPT_VERSION,
              explanation: hydrated,
              model: cached.sourceModel,
            });
          }
          return res.status(429).json({
            message: 'B蘯｡n ﾄ妥｣ dﾃｹng lﾆｰ盻｣t t蘯｡o gi蘯｣i thﾃｭch cho cﾃ｢u nﾃy. Vui lﾃｲng liﾃｪn h盻・admin n蘯ｿu c蘯ｧn lﾃm m盻嬖.',
          });
        }
      }

      const generated = await generateExamQuestionExplanation({
        level: body.level,
        examId: body.examId,
        part,
        sectionTitle: questionCtx.sectionTitle,
        questionLabel: questionCtx.questionLabel,
        mondaiLabel: questionCtx.mondaiLabel,
        questionType: questionCtx.questionType,
        questionTypeLabelVi: questionCtx.questionTypeLabelVi,
        typeStrategyVi: questionCtx.typeStrategyVi,
        questionText: questionCtx.questionText,
        questionWithBlank: questionCtx.questionWithBlank,
        questionWithAnswer: questionCtx.questionWithAnswer,
        blankLabels: questionCtx.blankLabels,
        isClozeQuestion: questionCtx.isClozeQuestion,
        options: questionCtx.options,
        correctAnswer: questionCtx.correctAnswer,
        passageText: questionCtx.passageText,
        sentenceOrderExpectedOrder: questionCtx.sentenceOrderExpectedOrder,
        precomputedReadings: {
          questionReadingHira: readingCache.question_reading_hira,
          questionRubyHtml: readingCache.question_ruby_html,
          optionReadings: readingCache.option_readings,
          optionRubyHtmls: readingCache.option_ruby_htmls,
        },
      });
      const hydratedGenerated = hydrateQuestionExplanationWithReadingCache(generated.explanation, readingCache);

      await saveCachedExplanation({
        level: body.level,
        examId: body.examId,
        part,
        sectionIndex,
        questionIndex,
        questionHash,
        explanation: hydratedGenerated,
        sourceModel: generated.model,
      });

      return res.json({
        source: 'openai',
        promptVersion: EXPLANATION_PROMPT_VERSION,
        explanation: hydratedGenerated,
        model: generated.model,
      });
    } catch (error) {
      return res.status((error as { status?: number }).status || 500).json({ message: (error as Error).message });
    }
  });

  router.post('/passage-explanation', async (req: Request, res: Response) => {
    const body = req.body as ExplainPassageRequest;
    if (
      !body?.userId ||
      !body?.level ||
      !body?.examId ||
      !Number.isInteger(Number(body.part)) ||
      !Number.isInteger(Number(body.sectionIndex)) ||
      !Array.isArray(body.questionIndexes) ||
      body.questionIndexes.length === 0
    ) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const part = Number(body.part);
    const sectionIndex = Number(body.sectionIndex);
    const forceRefresh = Boolean(body.forceRefresh);
    const questionIndexes = Array.from(
      new Set(
        body.questionIndexes
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value >= 0),
      ),
    ).sort((a, b) => a - b);

    if (![1, 2, 3].includes(part)) {
      return res.status(400).json({ message: 'Invalid part' });
    }
    if (sectionIndex < 0 || questionIndexes.length === 0) {
      return res.status(400).json({ message: 'Invalid sectionIndex/questionIndexes' });
    }

    try {
      await requireExamAccess(body.userId, body.code || '', body.level);
      await ensureQuestionExplanationTable();
      const user = await prisma.userAccount.findUnique({
        where: { id: BigInt(body.userId) },
        select: { role: true },
      });
      const isAdmin = String(user?.role || '').toUpperCase() === 'ADMIN';
      if (forceRefresh && !isAdmin) {
        return res.status(403).json({ message: 'Only admin can refresh explanation' });
      }

      const contextEntries: Array<{ context: QuestionContext; readingCache: QuestionReadingCache }> = [];
      for (const questionIndex of questionIndexes) {
        const context = await loadQuestionContext(body.level, body.examId, part, sectionIndex, questionIndex);
        const readingCache = await getOrCreateQuestionReadingCache({
          level: body.level,
          examId: body.examId,
          part,
          sectionIndex,
          questionIndex,
          questionText: context.questionText,
          options: context.options,
          passageText: context.passageText,
        });
        contextEntries.push({ context, readingCache });
      }
      const contexts = contextEntries.map((item) => item.context);
      const passageText = pickPrimaryPassageText(contexts);
      const blankLabels = contexts.map((item) => item.questionLabel).filter((value) => value.length > 0);
      const groupHash = createHash('sha256')
        .update(
          JSON.stringify({
            level: body.level,
            examId: body.examId,
            part,
            sectionIndex,
            questionIndexes,
            passageText,
            contexts,
          }),
        )
        .digest('hex');

      if (!forceRefresh) {
        const cached = await findCachedPassageExplanation({
          level: body.level,
          examId: body.examId,
          part,
          sectionIndex,
          groupHash,
        });
        if (cached) {
          return res.json({
            source: 'cache',
            promptVersion: EXPLANATION_PROMPT_VERSION,
            explanation: cached.explanation,
            model: cached.sourceModel,
          });
        }
      }

      if (!isAdmin) {
        const canGenerate = await consumeNonAdminPassageExplanationQuota({
          userId: body.userId,
          level: body.level,
          examId: body.examId,
          part,
          sectionIndex,
          groupHash,
        });
        if (!canGenerate) {
          const cached = await findCachedPassageExplanation({
            level: body.level,
            examId: body.examId,
            part,
            sectionIndex,
            groupHash,
          });
          if (cached) {
            return res.json({
              source: 'cache',
              promptVersion: EXPLANATION_PROMPT_VERSION,
              explanation: cached.explanation,
              model: cached.sourceModel,
            });
          }
          return res.status(429).json({
            message: 'Ban da dung luot tao giai thich cho doan nay. Vui long lien he admin neu can lam moi.',
          });
        }
      }

      const readingSeed = buildPassageReadingSeed(contextEntries, passageText);

      const generated = await generatePassageExplanation({
        level: body.level,
        examId: body.examId,
        part,
        sectionTitle: contexts[0]?.sectionTitle || '',
        mondaiLabel: contexts[0]?.mondaiLabel || '',
        questionType: contexts[0]?.questionType || 'reading_cloze',
        questionTypeLabelVi: contexts[0]?.questionTypeLabelVi || '',
        typeStrategyVi: contexts[0]?.typeStrategyVi || '',
        passageText,
        blankLabels,
        questions: contexts.map((ctx) => ({
          questionLabel: ctx.questionLabel,
          questionWithBlank: ctx.questionWithBlank || ctx.questionText,
          questionWithAnswer: ctx.questionWithAnswer || '',
          options: ctx.options,
          correctAnswer: ctx.correctAnswer,
        })),
        precomputedReadings: readingSeed,
      });

      await saveCachedPassageExplanation({
        level: body.level,
        examId: body.examId,
        part,
        sectionIndex,
        groupHash,
        explanation: generated.explanation,
        sourceModel: generated.model,
      });

      return res.json({
        source: 'openai',
        promptVersion: EXPLANATION_PROMPT_VERSION,
        explanation: generated.explanation,
        model: generated.model,
      });
    } catch (error) {
      return res.status((error as { status?: number }).status || 500).json({ message: (error as Error).message });
    }
  });

  router.get('/history', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    const page = Math.max(Number(req.query.page || 1), 1);
    const size = Math.min(Math.max(Number(req.query.size || 20), 1), 50);
    const code = String(req.query.code || '');
    try {
      await requireExamAccess(userId, code, null);
      const rows = await prisma.jlptAttempt.findMany({
        where: { user_id: BigInt(userId) },
        orderBy: { started_at: 'desc' },
        skip: (page - 1) * size,
        take: size,
      });
      return res.json({ items: rows, page, size });
    } catch (error) {
      return res.status((error as { status?: number }).status || 403).json({ message: (error as Error).message });
    }
  });

  router.get('/history/:attemptId', async (req: Request, res: Response) => {
    const attemptId = Number(req.params.attemptId);
    const userId = Number(req.query.userId);
    const code = String(req.query.code || '');
    try {
      await requireExamAccess(userId, code, null);
      const attempt = await prisma.jlptAttempt.findUnique({ where: { id: BigInt(attemptId) } });
      if (!attempt) return res.status(404).json({ message: 'Attempt not found' });
      if (Number(attempt.user_id) !== userId) return res.status(403).json({ message: 'Not allowed' });
      const items = await prisma.jlptAttemptItem.findMany({
        where: { attempt_id: BigInt(attemptId) },
        orderBy: [{ part: 'asc' }, { section_index: 'asc' }, { question_index: 'asc' }],
      });
      return res.json({ attempt, items });
    } catch (error) {
      return res.status((error as { status?: number }).status || 403).json({ message: (error as Error).message });
    }
  });

  return router;
}

async function requireExamAccess(userId: number, code: string, level: string | null) {
  if (!Number.isFinite(userId)) {
    const err = new Error('User not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const user = await prisma.userAccount.findUnique({ where: { id: BigInt(userId) } });
  if (!user) {
    const err = new Error('User not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  if (String(user.role || '').toUpperCase() === 'ADMIN') {
    return ['N5', 'N4', 'N3', 'N2', 'N1'];
  }
  if (!user.exam_enabled) {
    const err = new Error('Exam access not enabled') as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  if (!code?.trim()) {
    const err = new Error('Invalid code') as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  const rows = await prisma.userExamCode.findMany({
    where: { user_id: BigInt(userId), enabled: true, code },
    orderBy: { level: 'asc' },
  });
  const levels = rows.map((r: { level: string }) => r.level);
  if (!levels.length) {
    const err = new Error('Exam code not set') as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  if (level && !levels.includes(level)) {
    const err = new Error('Invalid code') as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  return levels;
}

type QuestionContext = {
  sectionTitle: string;
  questionLabel: string;
  mondaiLabel: string;
  questionType: JlptQuestionType;
  questionTypeLabelVi: string;
  typeStrategyVi: string;
  questionText: string;
  questionWithBlank: string;
  questionWithAnswer: string;
  blankLabels: string[];
  isClozeQuestion: boolean;
  options: Record<string, string>;
  correctAnswer: string;
  passageText: string;
  sentenceOrderExpectedOrder: string[];
};

type CachedExplainQuery = {
  level: string;
  examId: string;
  part: number;
  sectionIndex: number;
  questionIndex: number;
  questionHash: string;
};

type NonAdminExplainQuotaQuery = {
  userId: number;
  level: string;
  examId: string;
  part: number;
  sectionIndex: number;
  questionIndex: number;
};

type NonAdminPassageExplainQuotaQuery = {
  userId: number;
  level: string;
  examId: string;
  part: number;
  sectionIndex: number;
  groupHash: string;
};

type CacheRow = {
  explanation_json: unknown;
  source_model: string | null;
};

type PassageCacheQuery = {
  level: string;
  examId: string;
  part: number;
  sectionIndex: number;
  groupHash: string;
};

async function ensureQuestionExplanationTable() {
  if (!ensureExplainTablePromise) {
    ensureExplainTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS jlpt_question_explanation (
          id BIGSERIAL PRIMARY KEY,
          level VARCHAR(5) NOT NULL,
          exam_id VARCHAR(10) NOT NULL,
          part SMALLINT NOT NULL,
          section_index INT NOT NULL,
          question_index INT NOT NULL,
          question_hash VARCHAR(64) NOT NULL,
          prompt_version INT NOT NULL DEFAULT 4,
          explanation_json JSONB NOT NULL,
          source_model VARCHAR(100),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_jlpt_question_explain_key
        ON jlpt_question_explanation (
          level, exam_id, part, section_index, question_index, question_hash, prompt_version
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS jlpt_question_explanation_request_log (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL,
          level VARCHAR(5) NOT NULL,
          exam_id VARCHAR(10) NOT NULL,
          part SMALLINT NOT NULL,
          section_index INT NOT NULL,
          question_index INT NOT NULL,
          prompt_version INT NOT NULL DEFAULT 4,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_jlpt_question_explain_request_log
        ON jlpt_question_explanation_request_log (
          user_id, level, exam_id, part, section_index, question_index, prompt_version
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS jlpt_passage_explanation (
          id BIGSERIAL PRIMARY KEY,
          level VARCHAR(5) NOT NULL,
          exam_id VARCHAR(10) NOT NULL,
          part SMALLINT NOT NULL,
          section_index INT NOT NULL,
          group_hash VARCHAR(64) NOT NULL,
          prompt_version INT NOT NULL DEFAULT 4,
          explanation_json JSONB NOT NULL,
          source_model VARCHAR(100),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_jlpt_passage_explain_key
        ON jlpt_passage_explanation (
          level, exam_id, part, section_index, group_hash, prompt_version
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS jlpt_passage_explanation_request_log (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL,
          level VARCHAR(5) NOT NULL,
          exam_id VARCHAR(10) NOT NULL,
          part SMALLINT NOT NULL,
          section_index INT NOT NULL,
          group_hash VARCHAR(64) NOT NULL,
          prompt_version INT NOT NULL DEFAULT 4,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_jlpt_passage_explain_request_log
        ON jlpt_passage_explanation_request_log (
          user_id, level, exam_id, part, section_index, group_hash, prompt_version
        );
      `);
    })().catch((error) => {
      ensureExplainTablePromise = null;
      throw error;
    });
  }
  return ensureExplainTablePromise;
}

async function findCachedExplanation(query: CachedExplainQuery): Promise<{ explanation: ExamQuestionExplanation; sourceModel: string | null } | null> {
  const rows = await prisma.$queryRawUnsafe<Array<CacheRow>>(
    `
      SELECT explanation_json, source_model
      FROM jlpt_question_explanation
      WHERE level = $1
        AND exam_id = $2
        AND part = $3
        AND section_index = $4
        AND question_index = $5
        AND question_hash = $6
        AND prompt_version = $7
      LIMIT 1
    `,
    query.level,
    query.examId,
    query.part,
    query.sectionIndex,
    query.questionIndex,
    query.questionHash,
    EXPLANATION_PROMPT_VERSION,
  );
  if (!rows.length) return null;
  return {
    explanation: rows[0].explanation_json as ExamQuestionExplanation,
    sourceModel: rows[0].source_model,
  };
}

async function findCachedPassageExplanation(query: PassageCacheQuery): Promise<{ explanation: PassageExplanation; sourceModel: string | null } | null> {
  const rows = await prisma.$queryRawUnsafe<Array<CacheRow>>(
    `
      SELECT explanation_json, source_model
      FROM jlpt_passage_explanation
      WHERE level = $1
        AND exam_id = $2
        AND part = $3
        AND section_index = $4
        AND group_hash = $5
        AND prompt_version = $6
      LIMIT 1
    `,
    query.level,
    query.examId,
    query.part,
    query.sectionIndex,
    query.groupHash,
    EXPLANATION_PROMPT_VERSION,
  );
  if (!rows.length) return null;
  return {
    explanation: rows[0].explanation_json as PassageExplanation,
    sourceModel: rows[0].source_model,
  };
}

async function consumeNonAdminExplanationQuota(query: NonAdminExplainQuotaQuery): Promise<boolean> {
  const affected = await prisma.$executeRawUnsafe(
    `
      INSERT INTO jlpt_question_explanation_request_log (
        user_id, level, exam_id, part, section_index, question_index, prompt_version, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (user_id, level, exam_id, part, section_index, question_index, prompt_version)
      DO NOTHING
    `,
    query.userId,
    query.level,
    query.examId,
    query.part,
    query.sectionIndex,
    query.questionIndex,
    EXPLANATION_PROMPT_VERSION,
  );
  return Number(affected) > 0;
}

async function consumeNonAdminPassageExplanationQuota(query: NonAdminPassageExplainQuotaQuery): Promise<boolean> {
  const affected = await prisma.$executeRawUnsafe(
    `
      INSERT INTO jlpt_passage_explanation_request_log (
        user_id, level, exam_id, part, section_index, group_hash, prompt_version, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (user_id, level, exam_id, part, section_index, group_hash, prompt_version)
      DO NOTHING
    `,
    query.userId,
    query.level,
    query.examId,
    query.part,
    query.sectionIndex,
    query.groupHash,
    EXPLANATION_PROMPT_VERSION,
  );
  return Number(affected) > 0;
}

async function saveCachedExplanation(args: CachedExplainQuery & { explanation: ExamQuestionExplanation; sourceModel: string | null }) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO jlpt_question_explanation (
        level, exam_id, part, section_index, question_index, question_hash, prompt_version,
        explanation_json, source_model, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW(), NOW())
      ON CONFLICT (level, exam_id, part, section_index, question_index, question_hash, prompt_version)
      DO UPDATE SET
        explanation_json = EXCLUDED.explanation_json,
        source_model = EXCLUDED.source_model,
        updated_at = NOW()
    `,
    args.level,
    args.examId,
    args.part,
    args.sectionIndex,
    args.questionIndex,
    args.questionHash,
    EXPLANATION_PROMPT_VERSION,
    JSON.stringify(args.explanation),
    args.sourceModel,
  );
}

async function saveCachedPassageExplanation(args: PassageCacheQuery & { explanation: PassageExplanation; sourceModel: string | null }) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO jlpt_passage_explanation (
        level, exam_id, part, section_index, group_hash, prompt_version,
        explanation_json, source_model, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())
      ON CONFLICT (level, exam_id, part, section_index, group_hash, prompt_version)
      DO UPDATE SET
        explanation_json = EXCLUDED.explanation_json,
        source_model = EXCLUDED.source_model,
        updated_at = NOW()
    `,
    args.level,
    args.examId,
    args.part,
    args.sectionIndex,
    args.groupHash,
    EXPLANATION_PROMPT_VERSION,
    JSON.stringify(args.explanation),
    args.sourceModel,
  );
}

async function loadQuestionContext(
  level: string,
  examId: string,
  part: number,
  sectionIndex: number,
  questionIndex: number,
): Promise<QuestionContext> {
  const row = await prisma.jlptExam.findFirst({
    where: { level, exam_id: examId, part },
    select: { json_data: true },
  });
  if (!row) {
    const err = new Error('Exam part not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const json = (row.json_data || {}) as Record<string, unknown>;
  const sections = Array.isArray(json.sections) ? (json.sections as Array<Record<string, unknown>>) : [];
  const section = sections[sectionIndex];
  if (!section) {
    const err = new Error('Section not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const questions = Array.isArray(section.questions) ? (section.questions as Array<Record<string, unknown>>) : [];
  const q = questions[questionIndex];
  if (!q) {
    const err = new Error('Question not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const rawOptions = isObject(q.options) ? (q.options as Record<string, unknown>) : {};
  const options: Record<string, string> = {};
  for (const key of Object.keys(rawOptions)) {
    const value = toText(rawOptions[key]);
    if (value) options[key] = sanitizeOptionText(key, value);
  }

  const rawQuestionText = normalizeSpace(stripHtml(toText(q.question_html ?? q.ques) || ''));
  const correctAnswer = toText(q.correct_answer ?? q.answer) || '';
  const sectionTitle = normalizeSpace(stripHtml(toText(section.section_title ?? section.sec) || ''));
  const rawQuestionLabel = toText(q.question_id ?? q.qid) || `${questionIndex + 1}`;
  let metadata = await getExamQuestionMeta({
    level,
    examId,
    part,
    sectionIndex,
    questionIndex,
  });
  if (!metadata) {
    await upsertExamQuestionMetaForPart({
      level,
      examId,
      part,
      jsonData: json,
      force: false,
    });
    metadata = await getExamQuestionMeta({
      level,
      examId,
      part,
      sectionIndex,
      questionIndex,
    });
  }

  const fallbackDisplayQuestionNo = parseLeadingQuestionNo(rawQuestionText) ?? parseQuestionLabelNumber(rawQuestionLabel);
  const displayQuestionNo = metadata?.displayQuestionNo ?? fallbackDisplayQuestionNo;
  const labelForMarker = displayQuestionNo !== null ? String(displayQuestionNo) : rawQuestionLabel;
  const labelForInference = displayQuestionNo !== null ? String(displayQuestionNo) : rawQuestionLabel;
  const passageText = extractPassageText(json, q);
  const markerCandidates = buildBlankMarkerCandidates(rawQuestionText, labelForMarker);
  const sentenceWithBlank = extractSentenceAroundBlank(passageText, markerCandidates);
  const answerText = correctAnswer ? options[correctAnswer] || '' : '';
  const sentenceWithAnswer = replaceBlankMarker(sentenceWithBlank, markerCandidates, answerText);
  const isMarkerQuestion = isOnlyBlankMarker(rawQuestionText);
  const isClozeQuestion = Boolean(sentenceWithBlank) && isMarkerQuestion;
  const blankLabels = isClozeQuestion ? detectBlankLabels(passageText) : [];
  const questionWithBlank = isClozeQuestion ? sentenceWithBlank : rawQuestionText;
  const questionWithAnswer = isClozeQuestion ? sentenceWithAnswer : '';
  const fallbackMeta = inferJlptQuestionMeta({
    level,
    part,
    sectionTitle,
    questionLabel: labelForInference,
    questionText: rawQuestionText,
    optionTexts: Object.values(options),
    hasPassage: Boolean(passageText),
    isClozeQuestion,
  });
  const questionType = metadata?.questionType || fallbackMeta.questionType;
  const questionTypeDescriptor = describeJlptQuestionType(questionType);
  const mondaiLabel = metadata?.mondaiLabel || fallbackMeta.mondaiLabel;
  const rawExpl = toText(q.expl ?? q.explanation ?? q.exp) || '';
  const sentenceOrderExpectedOrder = parseSentenceOrderExpectedOrder(rawExpl, Object.keys(options));
  const questionText = buildQuestionPromptText({
    rawQuestionText,
    sentenceWithBlank: questionWithBlank,
    sentenceWithAnswer: questionWithAnswer,
    isClozeQuestion,
  });

  return {
    sectionTitle,
    questionLabel: rawQuestionLabel,
    mondaiLabel,
    questionType,
    questionTypeLabelVi: questionTypeDescriptor.questionTypeLabelVi,
    typeStrategyVi: questionTypeDescriptor.strategyVi,
    questionText,
    questionWithBlank,
    questionWithAnswer,
    blankLabels,
    isClozeQuestion,
    options,
    correctAnswer,
    passageText,
    sentenceOrderExpectedOrder,
  };
}

function extractPassageText(partJson: Record<string, unknown>, question: Record<string, unknown>): string {
  const passages = Array.isArray(partJson.passages) ? (partJson.passages as Array<Record<string, unknown>>) : [];
  if (!passages.length) return '';

  const rawPassageId = question.passage_id ?? question.pid;
  const ids = Array.isArray(rawPassageId) ? rawPassageId.map((item) => String(item)) : [String(rawPassageId ?? '')];
  const validIds = ids.filter((id) => id.length > 0);
  if (!validIds.length) return '';

  const texts: string[] = [];
  for (const p of passages) {
    const passageId = String(p.passage_id ?? p.pid ?? '');
    if (!validIds.includes(passageId)) continue;
    const rawText = toText(p.passage_html ?? p.passage) || '';
    const cleaned = normalizeSpace(stripHtml(rawText));
    if (cleaned) texts.push(cleaned);
  }
  return texts.join('\n');
}

function buildQuestionHash(question: QuestionContext): string {
  return createHash('sha256').update(JSON.stringify(question)).digest('hex');
}

function buildQuestionPromptText(args: {
  rawQuestionText: string;
  sentenceWithBlank: string;
  sentenceWithAnswer: string;
  isClozeQuestion: boolean;
}): string {
  if (args.isClozeQuestion) {
    if (args.sentenceWithBlank && args.sentenceWithAnswer) {
      return `Cﾃ｢u ch盻ｩa ch盻・tr盻創g: ${args.sentenceWithBlank}\nCﾃ｢u khi ﾄ訴盻］ ﾄ妥｡p ﾃ｡n ﾄ妥ｺng: ${args.sentenceWithAnswer}`;
    }
    if (args.sentenceWithBlank) return args.sentenceWithBlank;
  }
  return args.rawQuestionText;
}

function detectBlankLabels(passageText: string): string[] {
  const labels = new Set<string>();
  const re = /[()\uFF08\uFF09]\s*(\d{1,3})\s*[)\uFF09]/g;
  let match: RegExpExecArray | null = re.exec(passageText);
  while (match) {
    labels.add(String(Number(match[1])));
    match = re.exec(passageText);
  }
  return Array.from(labels).sort((a, b) => Number(a) - Number(b));
}

function buildBlankMarkerCandidates(rawQuestionText: string, questionLabel: string): string[] {
  const labels = new Set<string>();
  const questionText = String(rawQuestionText || '').trim();
  const labelText = String(questionLabel || '').trim();

  if (isOnlyBlankMarker(questionText)) {
    const markerDigits = extractDigits(questionText);
    if (markerDigits) labels.add(markerDigits);
  } else if (labelText) {
    labels.add(labelText);
    const digits = extractDigits(labelText);
    if (digits) labels.add(digits);
  }

  if (!labels.size) return [];
  const out = new Set<string>();
  for (const label of labels) {
    out.add(`(${label})`);
    out.add(`\uFF08${label}\uFF09`);
  }
  return Array.from(out);
}

function extractDigits(value: string): string {
  const m = value.match(/\d+/);
  return m ? String(Number(m[0])) : '';
}

function parseLeadingQuestionNo(text: string): number | null {
  const normalized = toAsciiDigitsLocal(String(text || ''));
  const m = normalized.match(/^\s*(\d{1,3})\s*[.．。]/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseQuestionLabelNumber(label: string): number | null {
  const normalized = toAsciiDigitsLocal(String(label || ''));
  const m = normalized.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function extractSentenceAroundBlank(passageText: string, markers: string[]): string {
  if (!passageText || !markers.length) return '';
  let markerIndex = -1;
  let markerValue = '';
  for (const marker of markers) {
    const index = passageText.indexOf(marker);
    if (index >= 0 && (markerIndex < 0 || index < markerIndex)) {
      markerIndex = index;
      markerValue = marker;
    }
  }
  if (markerIndex < 0 || !markerValue) return '';
  const start = findSentenceStart(passageText, markerIndex);
  const end = findSentenceEnd(passageText, markerIndex + markerValue.length);
  return normalizeSpace(passageText.slice(start, end));
}

function findSentenceStart(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (
      ch === '\n' ||
      ch === '\u3002' ||
      ch === '\uFF61' ||
      ch === '\uFF0E' ||
      ch === '\uFF01' ||
      ch === '\uFF1F' ||
      ch === '!' ||
      ch === '?'
    ) {
      return i + 1;
    }
  }
  return 0;
}

function findSentenceEnd(text: string, index: number): number {
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i];
    if (
      ch === '\n' ||
      ch === '\u3002' ||
      ch === '\uFF61' ||
      ch === '\uFF0E' ||
      ch === '\uFF01' ||
      ch === '\uFF1F' ||
      ch === '!' ||
      ch === '?'
    ) {
      return i + 1;
    }
  }
  return text.length;
}

function replaceBlankMarker(sentence: string, markers: string[], answerText: string): string {
  if (!sentence || !markers.length || !answerText) return '';
  for (const marker of markers) {
    if (sentence.includes(marker)) {
      return normalizeSpace(sentence.replace(marker, answerText));
    }
  }
  return '';
}

function isOnlyBlankMarker(text: string): boolean {
  if (!text) return false;
  const normalized = text.replace(/\s+/g, '');
  return /^[()\uFF08]?\d{1,3}[)\uFF09]?[.．。、]?$/.test(normalized);
}

function pickPrimaryPassageText(contexts: QuestionContext[]): string {
  const withPassage = contexts.map((item) => item.passageText).filter((value) => value.length > 0);
  if (!withPassage.length) return '';
  const byLength = [...withPassage].sort((a, b) => b.length - a.length);
  return byLength[0];
}

function buildPassageReadingSeed(
  entries: Array<{ context: QuestionContext; readingCache: QuestionReadingCache }>,
  passageText: string,
) {
  const primaryCache = pickPrimaryReadingCache(entries, passageText);
  const questionOptionReadings: Record<string, Record<string, string>> = {};
  const questionOptionRubyHtmls: Record<string, Record<string, string>> = {};
  const questionBlankReadings: Record<string, string> = {};
  const questionBlankRubyHtmls: Record<string, string> = {};

  entries.forEach((entry) => {
    const label = entry.context.questionLabel;
    questionOptionReadings[label] = entry.readingCache.option_readings || {};
    questionOptionRubyHtmls[label] = entry.readingCache.option_ruby_htmls || {};
    questionBlankReadings[label] = entry.readingCache.question_reading_hira || '';
    questionBlankRubyHtmls[label] = entry.readingCache.question_ruby_html || '';
  });

  return {
    passageRubyHtml: primaryCache?.passageRubyHtml || '',
    passageReadingHira: primaryCache?.passageReadingHira || '',
    sentenceReadings: primaryCache?.sentenceReadings || [],
    questionBlankReadings,
    questionBlankRubyHtmls,
    questionOptionReadings,
    questionOptionRubyHtmls,
  };
}

function pickPrimaryReadingCache(
  entries: Array<{ context: QuestionContext; readingCache: QuestionReadingCache }>,
  passageText: string,
): ReadingSeedQuestionData | null {
  if (!entries.length) return null;
  const exact = entries.find((entry) => entry.readingCache.passage_text === passageText);
  if (exact) return toReadingSeed(exact.readingCache);
  const withPassage = entries
    .map((entry) => entry.readingCache)
    .filter((cache) => (cache.passage_text || '').length > 0)
    .sort((a, b) => (b.passage_text || '').length - (a.passage_text || '').length);
  if (!withPassage.length) return null;
  return toReadingSeed(withPassage[0]);
}

function toReadingSeed(cache: QuestionReadingCache): ReadingSeedQuestionData {
  return {
    questionReadingHira: cache.question_reading_hira || '',
    questionRubyHtml: cache.question_ruby_html || '',
    optionReadings: cache.option_readings || {},
    optionRubyHtmls: cache.option_ruby_htmls || {},
    passageText: cache.passage_text || '',
    passageRubyHtml: cache.passage_ruby_html || '',
    passageReadingHira: cache.passage_reading_hira || '',
    sentenceReadings: Array.isArray(cache.sentence_readings)
      ? cache.sentence_readings.filter((item) => !isPassageSectionMarkerLabel(item.sentence_ja || ''))
      : [],
  };
}

function isPassageSectionMarkerLabel(value: string): boolean {
  const raw = String(value || '').trim();
  if (!raw) return true;
  const normalized = raw
    .replace(/[Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[（）]/g, (ch) => (ch === '（' ? '(' : ')'))
    .replace(/^[\s　]+|[\s　]+$/g, '');
  if (/^[A-Z]$/.test(normalized)) return true;
  if (/^\([A-Z0-9]+\)$/.test(normalized)) return true;
  if (/^\d+$/.test(normalized)) return true;
  if (/^\(\d+\)$/.test(normalized)) return true;
  if (/^[①-⑳]+$/.test(normalized)) return true;
  return false;
}

function hydrateQuestionExplanationWithReadingCache(
  explanation: ExamQuestionExplanation,
  readingCache: QuestionReadingCache,
): ExamQuestionExplanation {
  const optionReadings = readingCache.option_readings || {};
  const optionRubyHtmls = readingCache.option_ruby_htmls || {};
  const existingOptions = Array.isArray(explanation.options_with_reading) ? explanation.options_with_reading : [];
  const byOption = new Map(existingOptions.map((item) => [String(item.option || ''), item]));

  Object.keys(optionRubyHtmls).forEach((option) => {
    if (!byOption.has(option)) {
      byOption.set(option, {
        option,
        text_ja: '',
        text_ruby_html: '',
        reading_hira: '',
        meaning_vi: '',
      });
    }
  });

  const options_with_reading = Array.from(byOption.values())
    .map((item) => {
      const option = String(item.option || '');
      const textJa = sanitizeOptionText(option, String(item.text_ja || ''));
      return {
        ...item,
        option,
        text_ja: textJa,
        text_ruby_html: item.text_ruby_html || optionRubyHtmls[option] || '',
        reading_hira: item.reading_hira || optionReadings[option] || '',
      };
    })
    .sort((a, b) => Number(a.option || 0) - Number(b.option || 0));
  const optionTextByKey = Object.fromEntries(
    options_with_reading.map((item) => [String(item.option || ''), String(item.text_ja || '')]),
  );
  const sentence_order_solution = hydrateSentenceOrderSolutionWithOptionRuby(
    explanation.sentence_order_solution,
    optionTextByKey,
    optionRubyHtmls,
  );

  return {
    ...explanation,
    question_ruby_html: explanation.question_ruby_html || readingCache.question_ruby_html || '',
    question_reading_hira: explanation.question_reading_hira || readingCache.question_reading_hira || '',
    options_with_reading,
    sentence_order_solution,
  };
}

function hydrateSentenceOrderSolutionWithOptionRuby(
  solution: ExamQuestionExplanation['sentence_order_solution'],
  optionTextByKey: Record<string, string>,
  optionRubyHtmls: Record<string, string>,
): ExamQuestionExplanation['sentence_order_solution'] {
  if (!solution) return solution;
  const optionKeys = Object.keys(optionTextByKey)
    .filter((key) => key.length > 0)
    .sort((a, b) => Number(a) - Number(b));
  const inferred = inferOptionOrderFromSentenceLocal(solution.ordered_sentence_ja || '', optionTextByKey);
  const ordered = uniqueOptionKeysLocal([...(solution.ordered_options || []), ...inferred], optionKeys);
  const completedOrdered = optionKeys.length ? uniqueOptionKeysLocal([...ordered, ...optionKeys], optionKeys) : ordered;
  const ordered_sentence_ruby_html =
    solution.ordered_sentence_ruby_html ||
    injectRubyIntoKnownOptionSegments(solution.ordered_sentence_ja || '', optionTextByKey, optionRubyHtmls);

  return {
    ...solution,
    ordered_options: completedOrdered.length ? completedOrdered : solution.ordered_options,
    ordered_sentence_ruby_html,
  };
}

function inferOptionOrderFromSentenceLocal(
  sentence: string,
  optionTextByKey: Record<string, string>,
): string[] {
  const target = String(sentence || '');
  if (!target) return [];
  return Object.entries(optionTextByKey)
    .map(([option, optionText]) => ({
      option,
      index: optionText ? target.indexOf(optionText) : -1,
      length: String(optionText || '').length,
    }))
    .filter((item) => item.option.length > 0 && item.index >= 0)
    .sort((a, b) => a.index - b.index || b.length - a.length)
    .map((item) => item.option);
}

function uniqueOptionKeysLocal(values: string[], allowKeys: string[]): string[] {
  const allow = new Set(allowKeys);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const key = String(raw || '').trim();
    if (!key || !allow.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function injectRubyIntoKnownOptionSegments(
  sentence: string,
  optionTextByKey: Record<string, string>,
  optionRubyHtmls: Record<string, string>,
): string {
  let out = String(sentence || '');
  if (!out) return '';
  const entries = Object.entries(optionTextByKey)
    .map(([option, text]) => ({ option, text: String(text || ''), ruby: String(optionRubyHtmls[option] || '') }))
    .filter((item) => item.text.length > 0 && item.ruby.length > 0)
    .sort((a, b) => b.text.length - a.text.length);
  entries.forEach((item) => {
    if (!out.includes(item.text)) return;
    out = out.split(item.text).join(item.ruby);
  });
  return out;
}

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeSpace(input: string): string {
  return input
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function sanitizeOptionText(optionKey: string, input: string): string {
  const cleaned = normalizeSpace(stripHtml(input));
  const key = String(optionKey || '').trim();
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return cleaned
    .replace(/^[\s\u3000]*[0-9０-９]+[\s\u3000]*[.)．。､、:：\-－ー]?\s*/u, '')
    .replace(new RegExp(`^[\\s\\u3000]*${escapedKey}[\\s\\u3000]*[.)．。､、:：\\-－ー]?\\s*`, 'u'), '')
    .trim();
}

function parseSentenceOrderExpectedOrder(expl: string, optionKeys: string[]): string[] {
  const source = String(expl || '').replace(/<br\s*\/?>/gi, '\n');
  if (!source) return [];
  const patterns = [
    /[（(]\s*([0-9０-９]\s*[-－→]\s*[0-9０-９]\s*[-－→]\s*[0-9０-９]\s*[-－→]\s*[0-9０-９])\s*[）)]/u,
    /([0-9０-９]\s*[-－→]\s*[0-9０-９]\s*[-－→]\s*[0-9０-９]\s*[-－→]\s*[0-9０-９])/u,
  ];
  const allowed = new Set(optionKeys.map((key) => String(key)));

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const sequence = String(match[1] || match[0] || '')
      .split(/[-－→]/)
      .map((item) => toAsciiDigitsLocal(item).replace(/\D/g, ''))
      .filter((item) => item.length > 0);
    if (sequence.length !== optionKeys.length) continue;
    const unique = new Set(sequence);
    if (unique.size !== optionKeys.length) continue;
    if (!sequence.every((item) => allowed.has(item))) continue;
    return sequence;
  }
  return [];
}

function toAsciiDigitsLocal(value: string): string {
  return String(value || '').replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function scoreAttempt(parts: Array<{ part: number; json_data: unknown }>, answers: Record<string, string[]>) {
  const items: ScoredItem[] = [];
  let scoreSec1 = 0;
  let scoreSec2 = 0;
  let scoreSec3 = 0;

  for (const part of parts) {
    const answerList = answers[`part${part.part}`] || [];
    const json = part.json_data as { sections?: Array<{ questions?: Array<Record<string, unknown>> }> } | null;
    const sections = Array.isArray(json?.sections) ? json.sections : [];
    let flatIndex = 0;
    for (let si = 0; si < sections.length; si += 1) {
      const questions = Array.isArray(sections[si]?.questions) ? (sections[si]?.questions as Array<Record<string, unknown>>) : [];
      for (let qi = 0; qi < questions.length; qi += 1) {
        const q = questions[qi] || {};
        const correctAnswer = text(q.answer ?? q.correct_answer);
        const selected = text(answerList[flatIndex]);
        const isCorrect = Boolean(selected && correctAnswer && selected === correctAnswer);
        items.push({
          part: part.part,
          section_index: si,
          question_index: qi,
          question_id: text(q.qid ?? q.question_id),
          selected,
          correct_answer: correctAnswer,
          is_correct: isCorrect,
          question_json: q,
        });
        if (isCorrect) {
          if (part.part === 1) scoreSec1 += 1;
          if (part.part === 2) scoreSec2 += 1;
          if (part.part === 3) scoreSec3 += 1;
        }
        flatIndex += 1;
      }
    }
  }

  return {
    scoreSec1,
    scoreSec2,
    scoreSec3,
    scoreTotal: scoreSec1 + scoreSec2 + scoreSec3,
    items,
  };
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value);
  return str.length ? str : null;
}

