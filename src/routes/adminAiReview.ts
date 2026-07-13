import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { generateGeminiJson, generateGeminiGroundedText } from '../lib/gemini';
import { requireAdmin } from '../middleware/adminGuard';
import { upsertExamQuestionMetaForPart } from '../lib/examQuestionMeta';

type TargetType = 'vocabulary' | 'grammar' | 'grammar_usage' | 'kanji_compound' | 'exam_question';
type ReviewStatus = 'pending' | 'reviewed' | 'no_change' | 'failed' | 'accepted' | 'rejected' | 'applied';

type ReviewTarget = {
  targetType: TargetType;
  targetKey: string;
  originalJson: Record<string, unknown>;
};

type AiReviewResponse = {
  has_error?: boolean;
  confidence?: number;
  patch?: Record<string, unknown>;
  suggestions?: unknown[];
};

const PROMPT_VERSION = 1;
const MAX_CREATE_LIMIT = 5000;
const MAX_RUN_LIMIT = 50;
const AUTO_RUN_CHUNK_SIZE = 10;
const AUTO_RUN_DELAY_MS = 300;
const runningJobs = new Set<string>();
const cancelledJobs = new Set<string>();

const VOCAB_FIELDS = new Set([
  'word_ja',
  'word_hira_kana',
  'word_romaji',
  'word_vi',
  'example_ja',
  'example_vi',
  'topic',
  'level',
  'image_url',
  'audio_url',
  'core_order',
  'track',
  'source_book',
  'source_unit',
  'isFreePreview',
]);
const VOCAB_DEFAULT_FIELDS = ['word_hira_kana', 'word_romaji', 'word_vi', 'example_ja', 'example_vi'];

const GRAMMAR_FIELDS = new Set([
  'grammar_point',
  'grammar_point_romaji',
  'level',
  'topic',
  'meaning_vi',
  'grammar_usage_text',
  'note',
]);
const GRAMMAR_DEFAULT_FIELDS = ['meaning_vi', 'grammar_usage_text', 'note'];

const GRAMMAR_USAGE_FIELDS = new Set(['formation', 'example_ja', 'example_vi']);
const GRAMMAR_USAGE_DEFAULT_FIELDS = ['formation', 'example_ja', 'example_vi'];

const KANJI_COMPOUND_FIELDS = new Set(['reading_kana', 'meaning_vi', 'meaning_en', 'hanviet_word', 'priority']);
const KANJI_COMPOUND_DEFAULT_FIELDS = ['reading_kana', 'meaning_vi', 'meaning_en', 'hanviet_word'];

const EXAM_QUESTION_FIELDS = new Set([
  'ques',
  'question_html',
  'options',
  'expl',
  'explanation',
  'reading_overrides',
]);
const EXAM_QUESTION_DEFAULT_FIELDS = ['ques', 'question_html', 'options', 'expl', 'explanation', 'reading_overrides'];

export function createAdminAiReviewRouter() {
  const router = Router();

  router.post('/jobs', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    const targetType = normalizeTargetType(req.body?.targetType);
    if (!targetType) return res.status(400).json({ message: 'Unsupported targetType' });

    const filter = asObject(req.body?.filter);
    const options = asObject(req.body?.options);
    const targets = await loadTargets(targetType, filter);
    const model = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash');

    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.aiReviewJob.create({
        data: {
          targetType,
          status: targets.length ? 'queued' : 'completed',
          provider: 'gemini',
          model,
          filterJson: { ...filter, options },
          promptVersion: PROMPT_VERSION,
          total: targets.length,
          createdBy: BigInt(admin.id),
        },
      });
      if (targets.length) {
        await tx.aiReviewItem.createMany({
          data: targets.map((target) => ({
            jobId: created.id,
            targetType: target.targetType,
            targetKey: target.targetKey,
            status: 'pending',
            originalJson: toJsonObject(target.originalJson),
          })),
          skipDuplicates: true,
        });
      }
      return created;
    });

    const autoRun = req.body?.autoRun !== false;
    const jobKey = job.id.toString();
    if (autoRun && targets.length && !runningJobs.has(jobKey)) {
      runningJobs.add(jobKey);
      void autoRunJobLoop(job.id, jobKey);
    }

    return res.json({ job, total: targets.length, autoRunStarted: autoRun && targets.length > 0 });
  });

  router.get('/sources', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const targetType = normalizeTargetType(req.query.targetType) || 'vocabulary';
    if (targetType === 'vocabulary') {
      const rows = await prisma.$queryRaw<Array<{ source_book: string | null; track: string | null; cnt: bigint }>>(
        Prisma.sql`SELECT source_book, track, COUNT(*) as cnt FROM vocabulary GROUP BY source_book, track ORDER BY cnt DESC`,
      );
      return res.json({ items: rows.map((r) => ({ sourceBook: r.source_book, track: r.track, count: Number(r.cnt) })) });
    }
    if (targetType === 'grammar') {
      const rows = await prisma.$queryRaw<Array<{ source_book: string | null; track: string | null; cnt: bigint }>>(
        Prisma.sql`SELECT source_book, track, COUNT(*) as cnt FROM grammar GROUP BY source_book, track ORDER BY cnt DESC`,
      );
      return res.json({ items: rows.map((r) => ({ sourceBook: r.source_book, track: r.track, count: Number(r.cnt) })) });
    }
    return res.json({ items: [] });
  });

  router.get('/jobs', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const targetType = String(req.query.targetType || '').trim();
    const status = String(req.query.status || '').trim();
    const page = Math.max(Number(req.query.page || 0), 0);
    const size = Math.min(Math.max(Number(req.query.size || 20), 1), 100);
    const jobs = await prisma.aiReviewJob.findMany({
      where: {
        ...(targetType ? { targetType } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: page * size,
      take: size,
    });
    return res.json({ items: jobs, page, size });
  });

  router.get('/jobs/:jobId', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const jobId = parseBigIntParam(req.params.jobId);
    const job = await prisma.aiReviewJob.findUnique({ where: { id: jobId } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const grouped = await prisma.aiReviewItem.groupBy({
      by: ['status'],
      where: { jobId },
      _count: { _all: true },
    });
    return res.json({
      job,
      counts: Object.fromEntries(grouped.map((row) => [row.status, row._count._all])),
    });
  });

  router.get('/jobs/:jobId/items', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const jobId = parseBigIntParam(req.params.jobId);
    const status = String(req.query.status || '').trim();
    const page = Math.max(Number(req.query.page || 0), 0);
    const size = Math.min(Math.max(Number(req.query.size || 50), 1), 200);
    const items = await prisma.aiReviewItem.findMany({
      where: { jobId, ...(status ? { status } : {}) },
      orderBy: { id: 'asc' },
      skip: page * size,
      take: size,
    });
    return res.json({ items, page, size });
  });

  router.post('/jobs/:jobId/run', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const jobId = parseBigIntParam(req.params.jobId);
    const limit = Math.min(Math.max(Number(req.body?.limit || req.query.limit || 10), 1), MAX_RUN_LIMIT);
    const result = await runJobChunk(jobId, limit);
    if (!result) return res.status(404).json({ message: 'Job not found or unsupported targetType' });
    return res.json(result);
  });

  router.post('/jobs/:jobId/run-all', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const jobId = parseBigIntParam(req.params.jobId);
    const job = await prisma.aiReviewJob.findUnique({ where: { id: jobId } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const jobKey = jobId.toString();
    if (runningJobs.has(jobKey)) {
      return res.json({ started: false, alreadyRunning: true });
    }
    cancelledJobs.delete(jobKey);
    runningJobs.add(jobKey);
    void autoRunJobLoop(jobId, jobKey);
    return res.json({ started: true, alreadyRunning: false });
  });

  router.post('/jobs/:jobId/stop', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const jobId = parseBigIntParam(req.params.jobId);
    const result = await requestJobCancellation(jobId);
    if (!result) return res.status(404).json({ message: 'Job not found' });
    return res.json({ stopped: true, running: result.running });
  });

  router.post('/jobs/:jobId/cancel', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const jobId = parseBigIntParam(req.params.jobId);
    const result = await requestJobCancellation(jobId);
    if (!result) return res.status(404).json({ message: 'Job not found' });
    return res.json({ cancelled: true, running: result.running });
  });

  router.delete('/jobs/:jobId', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const jobId = parseBigIntParam(req.params.jobId);
    const job = await prisma.aiReviewJob.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const jobKey = jobId.toString();
    cancelledJobs.add(jobKey);
    await prisma.aiReviewJob.delete({ where: { id: jobId } });
    runningJobs.delete(jobKey);
    cancelledJobs.delete(jobKey);
    return res.json({ deleted: true });
  });

  router.get('/jobs/:jobId/run-status', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const jobId = parseBigIntParam(req.params.jobId);
    const jobKey = jobId.toString();
    return res.json({ running: runningJobs.has(jobKey), cancelling: cancelledJobs.has(jobKey) });
  });

  router.put('/items/:itemId/patch', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const itemId = parseBigIntParam(req.params.itemId);
    const item = await prisma.aiReviewItem.findUnique({ where: { id: itemId }, include: { job: true } });
    if (!item) return res.status(404).json({ message: 'Item not found' });
    const targetType = normalizeTargetType(item.targetType);
    if (!targetType) return res.status(400).json({ message: 'Unsupported targetType' });
    const allowedFields = resolveAllowedFields(targetType, item.job.filterJson);
    const patch = sanitizePatch(targetType, asObject(req.body?.patch || req.body), allowedFields);
    const updated = await prisma.aiReviewItem.update({
      where: { id: itemId },
      data: {
        status: Object.keys(patch).length ? 'reviewed' : 'no_change',
        suggestedPatch: patch as Prisma.InputJsonObject,
        updatedAt: new Date(),
      },
    });
    return res.json(updated);
  });

  router.post('/items/:itemId/accept', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const updated = await prisma.aiReviewItem.update({
      where: { id: parseBigIntParam(req.params.itemId) },
      data: { status: 'accepted', updatedAt: new Date() },
    });
    return res.json(updated);
  });

  router.post('/items/:itemId/reject', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const updated = await prisma.aiReviewItem.update({
      where: { id: parseBigIntParam(req.params.itemId) },
      data: { status: 'rejected', updatedAt: new Date() },
    });
    return res.json(updated);
  });

  router.post('/items/:itemId/apply', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    const item = await prisma.aiReviewItem.findUnique({ where: { id: parseBigIntParam(req.params.itemId) } });
    if (!item) return res.status(404).json({ message: 'Item not found' });
    const result = await applyReviewItem(item as unknown as ReviewItemRecord, admin.id);
    return res.json(result);
  });

  router.post('/items/bulk-accept', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const itemIds = parseItemIds(req.body?.itemIds);
    if (!itemIds.length) return res.status(400).json({ message: 'Missing itemIds' });
    const updated = await prisma.aiReviewItem.updateMany({
      where: { id: { in: itemIds } },
      data: { status: 'accepted', updatedAt: new Date() },
    });
    return res.json({ updated: updated.count });
  });

  router.post('/items/bulk-reject', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const itemIds = parseItemIds(req.body?.itemIds);
    if (!itemIds.length) return res.status(400).json({ message: 'Missing itemIds' });
    const updated = await prisma.aiReviewItem.updateMany({
      where: { id: { in: itemIds } },
      data: { status: 'rejected', updatedAt: new Date() },
    });
    return res.json({ updated: updated.count });
  });

  router.post('/items/bulk-apply', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    const itemIds = parseItemIds(req.body?.itemIds);
    if (!itemIds.length) return res.status(400).json({ message: 'Missing itemIds' });
    const items = await prisma.aiReviewItem.findMany({ where: { id: { in: itemIds } } });
    const results: unknown[] = [];
    const failed: Array<{ itemId: number; message: string }> = [];
    for (const item of items) {
      try {
        results.push(await applyReviewItem(item as unknown as ReviewItemRecord, admin.id));
      } catch (error) {
        failed.push({ itemId: Number(item.id), message: (error as Error).message });
      }
    }
    return res.json({ applied: results.length, failed });
  });

  router.post('/jobs/:jobId/apply', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    const jobId = parseBigIntParam(req.params.jobId);
    const limit = Math.min(Math.max(Number(req.body?.limit || 50), 1), 200);
    const items = await prisma.aiReviewItem.findMany({
      where: { jobId, status: 'accepted' },
      orderBy: { id: 'asc' },
      take: limit,
    });
    const results: unknown[] = [];
    const failed: Array<{ itemId: number; message: string }> = [];
    for (const item of items) {
      try {
        results.push(await applyReviewItem(item as unknown as ReviewItemRecord, admin.id));
      } catch (error) {
        failed.push({ itemId: Number(item.id), message: (error as Error).message });
      }
    }
    return res.json({ applied: results.length, failed });
  });

  router.get('/items/:itemId/apply-logs', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const itemId = parseBigIntParam(req.params.itemId);
    const logs = await prisma.aiReviewApplyLog.findMany({
      where: { itemId },
      orderBy: { id: 'desc' },
    });
    return res.json({ items: logs });
  });

  router.post('/apply-logs/:logId/restore', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    const log = await prisma.aiReviewApplyLog.findUnique({ where: { id: parseBigIntParam(req.params.logId) } });
    if (!log) return res.status(404).json({ message: 'Apply log not found' });
    const restored = await restoreApplyLog(log as unknown as ApplyLogRecord, admin.id);
    return res.json(restored);
  });

  return router;
}

type ReviewItemRecord = {
  id: bigint;
  targetType: string;
  targetKey: string;
  originalJson: unknown;
  suggestedPatch: unknown;
};

type ApplyLogRecord = {
  id: bigint;
  itemId: bigint;
  targetType: string;
  targetKey: string;
  beforeJson: unknown;
};

type RunChunkResult = { processed: number; failed: number; remaining: number; completed: number; total: number };

async function requestJobCancellation(jobId: bigint): Promise<{ running: boolean } | null> {
  const job = await prisma.aiReviewJob.findUnique({ where: { id: jobId }, select: { id: true } });
  if (!job) return null;
  const jobKey = jobId.toString();
  const running = runningJobs.has(jobKey);
  cancelledJobs.add(jobKey);
  if (!running) {
    await prisma.aiReviewJob.update({
      where: { id: jobId },
      data: { status: 'cancelled', updatedAt: new Date() },
    });
  }
  return { running };
}

async function cancelRunningJobIfRequested(jobId: bigint, jobKey: string): Promise<boolean> {
  if (!cancelledJobs.has(jobKey)) return false;
  cancelledJobs.delete(jobKey);
  await prisma.aiReviewJob.update({ where: { id: jobId }, data: { status: 'cancelled', updatedAt: new Date() } });
  return true;
}

async function runJobChunk(jobId: bigint, limit: number): Promise<RunChunkResult | null> {
  const job = await prisma.aiReviewJob.findUnique({ where: { id: jobId } });
  if (!job) return null;
  const targetType = normalizeTargetType(job.targetType);
  if (!targetType) return null;

  await prisma.aiReviewJob.update({ where: { id: jobId }, data: { status: 'running', updatedAt: new Date() } });
  const items = await prisma.aiReviewItem.findMany({
    where: { jobId, status: { in: ['pending', 'failed'] } },
    orderBy: { id: 'asc' },
    take: limit,
  });

  let processed = 0;
  let failed = 0;
  for (const item of items) {
    try {
      const allowedFields = resolveAllowedFields(targetType, job.filterJson);
      const result = isGroundedFillEnabled(job.filterJson)
        ? await reviewTargetWithGeminiGrounded(targetType, item.originalJson as Record<string, unknown>, allowedFields)
        : await reviewTargetWithGemini(targetType, item.originalJson as Record<string, unknown>, allowedFields);
      const patch = sanitizePatch(targetType, result.patch || {}, allowedFields);
      const hasPatch = Object.keys(patch).length > 0;
      // Surface any usable patch even when Gemini reports has_error:false (e.g. filling a
      // previously-empty field isn't "an error" but is still worth an admin's attention).
      const status: ReviewStatus = hasPatch ? 'reviewed' : 'no_change';
      await prisma.aiReviewItem.update({
        where: { id: item.id },
        data: {
          status,
          suggestedPatch: patch as Prisma.InputJsonObject,
          suggestions: Array.isArray(result.suggestions) ? (result.suggestions as Prisma.InputJsonArray) : [],
          confidence: normalizeConfidence(result.confidence),
          errorMessage: null,
          updatedAt: new Date(),
        },
      });
      processed += 1;
    } catch (error) {
      failed += 1;
      await prisma.aiReviewItem.update({
        where: { id: item.id },
        data: {
          status: 'failed',
          errorMessage: (error as Error).message,
          updatedAt: new Date(),
        },
      });
    }
  }

  const remaining = await prisma.aiReviewItem.count({ where: { jobId, status: { in: ['pending', 'failed'] } } });
  const completed = remaining === 0 ? 1 : 0;
  await prisma.aiReviewJob.update({
    where: { id: jobId },
    data: {
      status: remaining === 0 ? 'completed' : 'queued',
      processed: { increment: processed },
      failed: { increment: failed },
      updatedAt: new Date(),
    },
  });

  return { processed, failed, remaining, completed, total: job.total };
}

const MAX_CONSECUTIVE_FULL_FAILURE_CHUNKS = 3;

async function autoRunJobLoop(jobId: bigint, jobKey: string): Promise<void> {
  let consecutiveFullFailures = 0;
  try {
    for (;;) {
      if (await cancelRunningJobIfRequested(jobId, jobKey)) break;

      const result = await runJobChunk(jobId, AUTO_RUN_CHUNK_SIZE);
      if (!result || result.remaining === 0) break;

      if (await cancelRunningJobIfRequested(jobId, jobKey)) break;

      if (result.processed === 0 && result.failed > 0) {
        consecutiveFullFailures += 1;
        if (consecutiveFullFailures >= MAX_CONSECUTIVE_FULL_FAILURE_CHUNKS) {
          // Every item in the last few chunks failed outright (e.g. API key/billing issue) —
          // stop instead of retrying forever. Items stay 'failed' and can be re-run once fixed.
          await prisma.aiReviewJob.update({
            where: { id: jobId },
            data: { status: 'failed', updatedAt: new Date() },
          });
          break;
        }
      } else {
        consecutiveFullFailures = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, AUTO_RUN_DELAY_MS));
    }
  } catch (error) {
    await prisma.aiReviewJob
      .update({ where: { id: jobId }, data: { status: 'failed', updatedAt: new Date() } })
      .catch(() => undefined);
  } finally {
    runningJobs.delete(jobKey);
  }
}

async function loadTargets(targetType: TargetType, filter: Record<string, unknown>): Promise<ReviewTarget[]> {
  if (targetType === 'vocabulary') return loadVocabularyTargets(filter);
  if (targetType === 'grammar') return loadGrammarTargets(filter);
  if (targetType === 'grammar_usage') return loadGrammarUsageTargets(filter);
  if (targetType === 'kanji_compound') return loadKanjiCompoundTargets(filter);
  return loadExamQuestionTargets(filter);
}

async function loadVocabularyTargets(filter: Record<string, unknown>): Promise<ReviewTarget[]> {
  const limit = parseLimit(filter.limit);
  const keyword = text(filter.keyword);
  const topic = text(filter.topic);
  const topicPrefix = text(filter.topicPrefix);
  const level = text(filter.level);
  const track = text(filter.track);
  const sourceBook = text(filter.sourceBook);
  const sourceUnit = text(filter.sourceUnit);
  const rows = await prisma.vocabulary.findMany({
    where: {
      ...(keyword
        ? {
            OR: [
              { word_ja: { contains: keyword, mode: 'insensitive' } },
              { word_hira_kana: { contains: keyword, mode: 'insensitive' } },
              { word_vi: { contains: keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(topic ? { topic } : {}),
      ...(topicPrefix ? { topic: { startsWith: topicPrefix } } : {}),
      ...(level ? { level } : {}),
      ...(track ? { track } : {}),
      ...(sourceBook ? { source_book: sourceBook } : {}),
      ...(sourceUnit ? { source_unit: sourceUnit } : {}),
    },
    orderBy: { id: 'asc' },
    take: limit,
  });
  return rows.map((row) => ({
    targetType: 'vocabulary',
    targetKey: `vocabulary:${row.id}`,
    originalJson: toJsonObject(row),
  }));
}

async function loadGrammarTargets(filter: Record<string, unknown>): Promise<ReviewTarget[]> {
  const limit = parseLimit(filter.limit);
  const level = text(filter.level);
  const track = text(filter.track);
  const sourceBook = text(filter.sourceBook);
  const sourceUnit = text(filter.sourceUnit);
  const rows = await prisma.grammar.findMany({
    where: {
      ...(level ? { level } : {}),
      ...(track ? { track } : {}),
      ...(sourceBook ? { source_book: sourceBook } : {}),
      ...(sourceUnit ? { source_unit: sourceUnit } : {}),
    },
    orderBy: { grammar_id: 'asc' },
    take: limit,
  });
  return rows.map((row) => ({
    targetType: 'grammar',
    targetKey: `grammar:${row.grammar_id}`,
    originalJson: toJsonObject(row),
  }));
}

async function loadGrammarUsageTargets(filter: Record<string, unknown>): Promise<ReviewTarget[]> {
  const limit = parseLimit(filter.limit);
  const level = text(filter.level);
  const track = text(filter.track);
  const sourceBook = text(filter.sourceBook);
  const sourceUnit = text(filter.sourceUnit);
  const rows = await prisma.grammarUsage.findMany({
    where: {
      grammar: {
        ...(level ? { level } : {}),
        ...(track ? { track } : {}),
        ...(sourceBook ? { source_book: sourceBook } : {}),
        ...(sourceUnit ? { source_unit: sourceUnit } : {}),
      },
    },
    include: { grammar: true },
    orderBy: { usage_id: 'asc' },
    take: limit,
  });
  return rows.map((row) => ({
    targetType: 'grammar_usage',
    targetKey: `grammar_usage:${row.usage_id}`,
    originalJson: toJsonObject(row),
  }));
}

async function loadKanjiCompoundTargets(filter: Record<string, unknown>): Promise<ReviewTarget[]> {
  const limit = parseLimit(filter.limit);
  const kanji = text(filter.kanji);
  const keyword = text(filter.keyword);
  const source = text(filter.source);
  const rows = await prisma.$queryRaw<
    Array<Record<string, unknown>>
  >(Prisma.sql`
    SELECT id, kanji_char, word_ja, reading_kana, meaning_vi, meaning_en, hanviet_word, source, source_ref, priority
    FROM kanji_compound
    WHERE ${kanji ? Prisma.sql`kanji_char = ${kanji}` : Prisma.sql`TRUE`}
      AND ${source ? Prisma.sql`source = ${source}` : Prisma.sql`TRUE`}
      AND ${keyword ? Prisma.sql`(word_ja ILIKE ${`%${keyword}%`} OR meaning_vi ILIKE ${`%${keyword}%`})` : Prisma.sql`TRUE`}
    ORDER BY id ASC
    LIMIT ${limit}
  `);
  return rows.map((row) => ({
    targetType: 'kanji_compound',
    targetKey: `kanji_compound:${String(row.id)}`,
    originalJson: toJsonObject(row),
  }));
}

async function loadExamQuestionTargets(filter: Record<string, unknown>): Promise<ReviewTarget[]> {
  const limit = parseLimit(filter.limit);
  const level = text(filter.level);
  const examId = text(filter.examId);
  const part = Number(filter.part || 0);
  const rows = await prisma.jlptExam.findMany({
    where: {
      ...(level ? { level } : {}),
      ...(examId ? { exam_id: examId } : {}),
      ...(Number.isFinite(part) && part > 0 ? { part } : {}),
    },
    orderBy: [{ level: 'asc' }, { exam_id: 'asc' }, { part: 'asc' }],
    take: Math.min(limit, 50),
  });
  const out: ReviewTarget[] = [];
  for (const row of rows) {
    const json = asObject(row.json_data);
    const sections = Array.isArray(json.sections) ? (json.sections as Array<Record<string, unknown>>) : [];
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      const questions = Array.isArray(sections[sectionIndex]?.questions)
        ? (sections[sectionIndex].questions as Array<Record<string, unknown>>)
        : [];
      for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
        if (out.length >= limit) return out;
        out.push({
          targetType: 'exam_question',
          targetKey: `exam_question:${row.level}:${row.exam_id}:${row.part}:${sectionIndex}:${questionIndex}`,
          originalJson: toJsonObject({
            level: row.level,
            exam_id: row.exam_id,
            part: row.part,
            sectionIndex,
            questionIndex,
            section: {
              sec: sections[sectionIndex]?.sec,
              section_title: sections[sectionIndex]?.section_title,
            },
            question: questions[questionIndex],
          }),
        });
      }
    }
  }
  return out;
}

async function reviewTargetWithGemini(
  targetType: TargetType,
  original: Record<string, unknown>,
  allowedFields: string[],
): Promise<AiReviewResponse> {
  const systemInstruction =
    'Ban la chuyen gia bien tap noi dung hoc tieng Nhat cho nguoi Viet. ' +
    'Chi tra ve JSON hop le. Khong markdown. Khong tu y doi nghia hoac them thong tin moi.';
  const prompt = `
Kiem tra ban ghi ${targetType}.

Chi duoc de xuat sua cac field sau: ${allowedFields.join(', ')}
Neu khong chac, khong sua field do va ghi ly do trong suggestions.

Tra ve JSON dung schema:
{
  "has_error": boolean,
  "confidence": number,
  "patch": { "field_name": "gia tri moi" },
  "suggestions": [
    {
      "field": "field_name",
      "original": "noi dung goc",
      "suggested": "noi dung de xuat",
      "reason_vi": "giai thich ngan bang tieng Viet",
      "severity": "low|medium|high"
    }
  ]
}

Quy tac:
- Patch chi gom field that su can sua.
- Giu nguyen HTML/ruby hop le neu co.
- Voi de thi, khong sua dap an dung; neu nghi dap an sai chi ghi suggestion, khong dua vao patch.
- Voi kanji compound, khong sua kanji_char, word_ja, source, source_ref.
${buildTargetSpecificRules(targetType)}

Du lieu:
${JSON.stringify(original, null, 2)}
`.trim();

  const result = await generateGeminiJson({
    systemInstruction,
    prompt,
    temperature: 0.1,
  });
  return asObject(result.json) as AiReviewResponse;
}

// Two-step review for filling genuinely missing content (as opposed to fixing existing
// content): step 1 asks Gemini to research the field via Google Search grounding (can't be
// combined with strict JSON mode in one call), step 2 structures that research into the
// normal patch/suggestions schema. Roughly 2x the API calls/cost of reviewTargetWithGemini,
// so it's opt-in per job via options.groundedFill, not the default path.
async function reviewTargetWithGeminiGrounded(
  targetType: TargetType,
  original: Record<string, unknown>,
  allowedFields: string[],
): Promise<AiReviewResponse> {
  const groundingSystemInstruction =
    'Ban la chuyen gia bien tap noi dung hoc tieng Nhat cho nguoi Viet. ' +
    'Dung tim kiem thuc te (google_search) de kiem tra va bo sung noi dung con thieu hoac sai. ' +
    'TUYET DOI khong bia dat: neu khong tim duoc thong tin dang tin cay cho mot field, phai noi ro la khong chac chan thay vi doan hoac tu bia ra vi du/nghia.';
  const groundingPrompt = `
Ban ghi ${targetType} sau co the dang thieu hoac sai o cac field: ${allowedFields.join(', ')}
${buildTargetSpecificRules(targetType)}

Hay tim kiem thong tin thuc te (tu dien, sach giao khoa JLPT, nguon uy tin) de xac minh cac field da co va bo sung cac field con thieu/rong.
Neu field da co du lieu dung, ghi ro la giu nguyen.
Neu khong tim duoc thong tin dang tin cay cho mot field con thieu, ghi ro "khong tim duoc thong tin dang tin cay" cho field do, KHONG duoc tu bia ra vi du hay nghia.

Du lieu hien tai:
${JSON.stringify(original, null, 2)}

Tra loi ngan gon, ro rang bang tieng Viet: liet ke tung field can sua hoac bo sung, gia tri de xuat, va can cu/nguon tham khao neu co.
`.trim();

  const grounded = await generateGeminiGroundedText({
    systemInstruction: groundingSystemInstruction,
    prompt: groundingPrompt,
    temperature: 0.1,
  });

  const structurePrompt = `
Dua vao ket qua nghien cuu ben duoi, hay tao JSON patch chuan cho ban ghi ${targetType}.

Chi duoc de xuat sua cac field sau: ${allowedFields.join(', ')}
Neu ket qua nghien cuu noi "khong tim duoc thong tin dang tin cay" cho field nao, KHONG duoc dua field do vao patch, chi ghi vao suggestions voi ly do.
Khong tu bia them noi dung ngoai nhung gi ket qua nghien cuu da neu.

Ket qua nghien cuu:
${grounded.text}

Du lieu goc:
${JSON.stringify(original, null, 2)}

Tra ve JSON dung schema:
{
  "has_error": boolean,
  "confidence": number,
  "patch": { "field_name": "gia tri moi" },
  "suggestions": [
    {
      "field": "field_name",
      "original": "noi dung goc",
      "suggested": "noi dung de xuat",
      "reason_vi": "giai thich ngan bang tieng Viet, neu co the ghi ro can cu/nguon",
      "severity": "low|medium|high"
    }
  ]
}
`.trim();

  const result = await generateGeminiJson({
    systemInstruction: 'Ban la chuyen gia bien tap noi dung hoc tieng Nhat. Chi tra ve JSON hop le, khong markdown.',
    prompt: structurePrompt,
    temperature: 0.1,
  });
  return asObject(result.json) as AiReviewResponse;
}

function isGroundedFillEnabled(filterJson: unknown): boolean {
  return Boolean(asObject(asObject(filterJson).options).groundedFill);
}

function buildTargetSpecificRules(targetType: TargetType): string {
  if (targetType === 'vocabulary') {
    return `
Kiem tra rieng cho tu vung:
- Voi word_hira_kana/word_romaji: uu tien cach doc THONG DUNG/PHO BIEN trong tieng Nhat hien dai va theo chuan JLPT, KHONG PHAI chi mot cach doc "hop le" ve mat am Han. Vi du: 日本 thuong doc "にほん" trong giao tiep hang ngay va van canh thong thuong; chi doc "にっぽん" trong ngu canh trang trong/ten goi chinh thuc (vi du 日本銀行, co dong the thao). Neu example_ja khong phai ngu canh trang trong ma word_hira_kana dang la mot cach doc it dung hon, hay de xuat sua theo cach doc pho bien hon.
- word_vi phai la tieng Viet, khong duoc lan tieng Anh; neu phat hien word_vi bi lan tieng Anh, de xuat sua lai bang tieng Viet.
- Neu example_ja/example_vi dang trong nhung cac field khac da du du lieu de suy ra vi du hop ly, co the de xuat bo sung (has_error=false van duoc, chi can patch co gia tri).`;
  }
  if (targetType === 'kanji_compound') {
    return `
Kiem tra rieng cho tu ghep kanji:
- meaning_vi PHAI la tieng Viet thuan tuy, KHONG duoc lan tieng Anh trong do.
- meaning_en PHAI la tieng Anh thuan tuy, KHONG duoc lan tieng Viet trong do.
- Neu phat hien meaning_vi hoac meaning_en dang bi lan ngon ngu (vi du meaning_vi lai chua tu tieng Anh, hoac nguoc lai), danh dau has_error=true va de xuat patch sua lai dung ngon ngu tuong ung, giu nguyen y nghia.
- hanviet_word phai la am Han Viet cua CA cum kanji_char tuong ung trong word_ja (khong duoc bo sot am tiet nao).`;
  }
  return '';
}

function resolveAllowedFields(targetType: TargetType, filterJson: unknown): string[] {
  const requested = Array.isArray(asObject(asObject(filterJson).options).fields)
    ? (asObject(asObject(filterJson).options).fields as unknown[]).map((item) => String(item))
    : [];
  const defaults =
    targetType === 'vocabulary'
      ? VOCAB_DEFAULT_FIELDS
      : targetType === 'grammar'
        ? GRAMMAR_DEFAULT_FIELDS
        : targetType === 'grammar_usage'
          ? GRAMMAR_USAGE_DEFAULT_FIELDS
          : targetType === 'kanji_compound'
            ? KANJI_COMPOUND_DEFAULT_FIELDS
            : EXAM_QUESTION_DEFAULT_FIELDS;
  const allowedSet = getFieldSet(targetType);
  const picked = (requested.length ? requested : defaults).filter((field) => allowedSet.has(field));
  return picked.length ? picked : defaults;
}

function sanitizePatch(
  targetType: TargetType,
  patch: Record<string, unknown>,
  allowedFields: string[],
): Record<string, unknown> {
  const allowed = new Set(allowedFields.filter((field) => getFieldSet(targetType).has(field)));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!allowed.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (key === 'core_order' || key === 'priority') {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = Math.floor(n);
      continue;
    }
    if (key === 'isFreePreview') {
      out[key] = Boolean(value);
      continue;
    }
    if (key === 'options' || key === 'reading_overrides') {
      if (typeof value === 'object') out[key] = value;
      continue;
    }
    const textValue = String(value);
    if (textValue.trim().length) out[key] = textValue;
  }
  return out;
}

async function applyReviewItem(item: ReviewItemRecord, adminId: number) {
  const targetType = normalizeTargetType(item.targetType);
  if (!targetType) throw new Error('Unsupported targetType');
  const patch = asObject(item.suggestedPatch);
  if (!Object.keys(patch).length) throw new Error('Item has empty patch');
  if (targetType === 'vocabulary') return applyVocabularyItem(item, patch, adminId);
  if (targetType === 'grammar') return applyGrammarItem(item, patch, adminId);
  if (targetType === 'grammar_usage') return applyGrammarUsageItem(item, patch, adminId);
  if (targetType === 'kanji_compound') return applyKanjiCompoundItem(item, patch, adminId);
  return applyExamQuestionItem(item, patch, adminId);
}

async function applyVocabularyItem(item: ReviewItemRecord, patch: Record<string, unknown>, adminId: number) {
  const id = parseTargetId(item.targetKey, 'vocabulary');
  const before = await prisma.vocabulary.findUnique({ where: { id: BigInt(id) } });
  if (!before) throw new Error('Vocabulary not found');
  const data = sanitizePatch('vocabulary', patch, Array.from(VOCAB_FIELDS));
  const after = await prisma.vocabulary.update({ where: { id: BigInt(id) }, data: data as any });
  return saveApplyResult(item, before, data, after, adminId);
}

async function applyGrammarItem(item: ReviewItemRecord, patch: Record<string, unknown>, adminId: number) {
  const id = parseTargetId(item.targetKey, 'grammar');
  const before = await prisma.grammar.findUnique({ where: { grammar_id: BigInt(id) } });
  if (!before) throw new Error('Grammar not found');
  const data = sanitizePatch('grammar', patch, Array.from(GRAMMAR_FIELDS));
  const after = await prisma.grammar.update({ where: { grammar_id: BigInt(id) }, data: data as any });
  return saveApplyResult(item, before, data, after, adminId);
}

async function applyGrammarUsageItem(item: ReviewItemRecord, patch: Record<string, unknown>, adminId: number) {
  const id = parseTargetId(item.targetKey, 'grammar_usage');
  const before = await prisma.grammarUsage.findUnique({ where: { usage_id: BigInt(id) } });
  if (!before) throw new Error('Grammar usage not found');
  const data = sanitizePatch('grammar_usage', patch, Array.from(GRAMMAR_USAGE_FIELDS));
  const after = await prisma.grammarUsage.update({ where: { usage_id: BigInt(id) }, data: data as any });
  return saveApplyResult(item, before, data, after, adminId);
}

async function applyKanjiCompoundItem(item: ReviewItemRecord, patch: Record<string, unknown>, adminId: number) {
  const id = parseTargetId(item.targetKey, 'kanji_compound');
  const beforeRows = await prisma.$queryRaw<Array<Record<string, unknown>>>(
    Prisma.sql`SELECT * FROM kanji_compound WHERE id = ${id} LIMIT 1`,
  );
  const before = beforeRows[0];
  if (!before) throw new Error('Kanji compound not found');
  const data = sanitizePatch('kanji_compound', patch, Array.from(KANJI_COMPOUND_FIELDS));
  await prisma.$executeRaw(
    Prisma.sql`
      UPDATE kanji_compound
      SET
        reading_kana = COALESCE(${text(data.reading_kana)}, reading_kana),
        meaning_vi = COALESCE(${text(data.meaning_vi)}, meaning_vi),
        meaning_en = COALESCE(${text(data.meaning_en)}, meaning_en),
        hanviet_word = COALESCE(${text(data.hanviet_word)}, hanviet_word),
        priority = COALESCE(${typeof data.priority === 'number' ? data.priority : null}, priority),
        updated_at = NOW()
      WHERE id = ${id}
    `,
  );
  await prisma.$executeRawUnsafe('TRUNCATE TABLE kanji_compound_lookup_cache');
  const afterRows = await prisma.$queryRaw<Array<Record<string, unknown>>>(
    Prisma.sql`SELECT * FROM kanji_compound WHERE id = ${id} LIMIT 1`,
  );
  return saveApplyResult(item, before, data, afterRows[0], adminId);
}

async function applyExamQuestionItem(item: ReviewItemRecord, patch: Record<string, unknown>, adminId: number) {
  const parsed = parseExamQuestionTargetKey(item.targetKey);
  const exam = await prisma.jlptExam.findFirst({
    where: { level: parsed.level, exam_id: parsed.examId, part: parsed.part },
  });
  if (!exam) throw new Error('Exam part not found');

  const json = deepClone(asObject(exam.json_data));
  const sections = Array.isArray(json.sections) ? (json.sections as Array<Record<string, unknown>>) : [];
  const section = sections[parsed.sectionIndex];
  const questions = Array.isArray(section?.questions) ? (section.questions as Array<Record<string, unknown>>) : [];
  const beforeQuestion = questions[parsed.questionIndex];
  if (!beforeQuestion) throw new Error('Exam question not found');

  const data = sanitizePatch('exam_question', patch, Array.from(EXAM_QUESTION_FIELDS));
  questions[parsed.questionIndex] = { ...beforeQuestion, ...data };

  await prisma.$transaction(async (tx) => {
    await tx.jlptExamRevision.create({
      data: {
        level: parsed.level,
        exam_id: parsed.examId,
        part: parsed.part,
        editor_id: BigInt(adminId),
        note: `ai-review item ${item.id}`,
        json_data: exam.json_data as Prisma.InputJsonValue,
      },
    });
    await tx.jlptExam.update({
      where: {
        level_exam_id_part: {
          level: parsed.level,
          exam_id: parsed.examId,
          part: parsed.part,
        },
      },
      data: { json_data: json as Prisma.InputJsonObject },
    });
  });
  await upsertExamQuestionMetaForPart({
    level: parsed.level,
    examId: parsed.examId,
    part: parsed.part,
    jsonData: json,
    force: true,
  });
  return saveApplyResult(item, beforeQuestion, data, questions[parsed.questionIndex], adminId);
}

async function saveApplyResult(
  item: ReviewItemRecord,
  before: unknown,
  patch: Record<string, unknown>,
  after: unknown,
  adminId: number,
) {
  const [log] = await prisma.$transaction([
    prisma.aiReviewApplyLog.create({
      data: {
        itemId: item.id,
        targetType: item.targetType,
        targetKey: item.targetKey,
        beforeJson: toJsonValue(before),
        patchJson: patch as Prisma.InputJsonObject,
        afterJson: toJsonValue(after),
        appliedBy: BigInt(adminId),
      },
    }),
    prisma.aiReviewItem.update({
      where: { id: item.id },
      data: { status: 'applied', appliedBy: BigInt(adminId), appliedAt: new Date(), updatedAt: new Date() },
    }),
  ]);
  return { applied: true, log };
}

async function restoreApplyLog(log: ApplyLogRecord, adminId: number) {
  const targetType = normalizeTargetType(log.targetType);
  if (!targetType) throw new Error('Unsupported targetType');
  const before = asObject(log.beforeJson);
  if (targetType === 'vocabulary') {
    const id = parseTargetId(log.targetKey, 'vocabulary');
    await prisma.vocabulary.update({
      where: { id: BigInt(id) },
      data: sanitizePatch('vocabulary', before, Array.from(VOCAB_FIELDS)) as any,
    });
  } else if (targetType === 'grammar') {
    const id = parseTargetId(log.targetKey, 'grammar');
    await prisma.grammar.update({
      where: { grammar_id: BigInt(id) },
      data: sanitizePatch('grammar', before, Array.from(GRAMMAR_FIELDS)) as any,
    });
  } else if (targetType === 'grammar_usage') {
    const id = parseTargetId(log.targetKey, 'grammar_usage');
    await prisma.grammarUsage.update({
      where: { usage_id: BigInt(id) },
      data: sanitizePatch('grammar_usage', before, Array.from(GRAMMAR_USAGE_FIELDS)) as any,
    });
  } else {
    throw new Error('Restore for this targetType is not implemented yet');
  }
  await prisma.aiReviewApplyLog.create({
    data: {
      itemId: log.itemId,
      targetType: log.targetType,
      targetKey: log.targetKey,
      beforeJson: {},
      patchJson: { restoreFromLogId: Number(log.id) },
      afterJson: toJsonObject(before),
      appliedBy: BigInt(adminId),
    },
  });
  return { restored: true };
}

function getFieldSet(targetType: TargetType): Set<string> {
  if (targetType === 'vocabulary') return VOCAB_FIELDS;
  if (targetType === 'grammar') return GRAMMAR_FIELDS;
  if (targetType === 'grammar_usage') return GRAMMAR_USAGE_FIELDS;
  if (targetType === 'kanji_compound') return KANJI_COMPOUND_FIELDS;
  return EXAM_QUESTION_FIELDS;
}

function normalizeTargetType(value: unknown): TargetType | null {
  const target = String(value || '').trim();
  if (
    target === 'vocabulary' ||
    target === 'grammar' ||
    target === 'grammar_usage' ||
    target === 'kanji_compound' ||
    target === 'exam_question'
  ) {
    return target;
  }
  return null;
}

function parseLimit(value: unknown): number {
  const n = Number(value || 50);
  return Math.min(Math.max(Number.isFinite(n) ? Math.floor(n) : 50, 1), MAX_CREATE_LIMIT);
}

function parseBigIntParam(value: string): bigint {
  if (!/^\d+$/.test(String(value || ''))) {
    const error = new Error('Invalid id') as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  return BigInt(value);
}

function parseItemIds(value: unknown): bigint[] {
  if (!Array.isArray(value)) return [];
  const ids: bigint[] = [];
  for (const item of value) {
    if (/^\d+$/.test(String(item ?? ''))) ids.push(BigInt(item as string));
  }
  return ids.slice(0, 500);
}

function parseTargetId(targetKey: string, prefix: string): number {
  const raw = String(targetKey || '');
  const marker = `${prefix}:`;
  if (!raw.startsWith(marker)) throw new Error(`Invalid ${prefix} target key`);
  const id = Number(raw.slice(marker.length));
  if (!Number.isFinite(id) || id <= 0) throw new Error(`Invalid ${prefix} id`);
  return id;
}

function parseExamQuestionTargetKey(targetKey: string) {
  const parts = String(targetKey || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'exam_question') throw new Error('Invalid exam question target key');
  return {
    level: parts[1],
    examId: parts[2],
    part: Number(parts[3]),
    sectionIndex: Number(parts[4]),
    questionIndex: Number(parts[5]),
  };
}

function asObject(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeConfidence(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (item instanceof Date) return item.toISOString();
      return item;
    }),
  ) as Prisma.InputJsonValue;
}

function toJsonObject(value: unknown): Prisma.InputJsonObject {
  return asObject(toJsonValue(value)) as Prisma.InputJsonObject;
}
