import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

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
