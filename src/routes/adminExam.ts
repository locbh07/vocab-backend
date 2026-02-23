import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAdmin } from '../middleware/adminGuard';

export function createAdminExamRouter() {
  const router = Router();

  router.get('/:level/:examId/part/:part', async (req: Request, res: Response) => {
    await requireAdmin(req);
    const level = String(req.params.level);
    const examId = String(req.params.examId);
    const part = Number(req.params.part);
    const exam = await prisma.jlptExam.findFirst({ where: { level, exam_id: examId, part } });
    if (!exam) return res.status(404).json({ message: 'Exam part not found' });

    const revisions = await prisma.jlptExamRevision.findMany({
      where: { level, exam_id: examId, part },
      orderBy: { created_at: 'desc' },
    });

    return res.json({
      level,
      examId,
      part,
      json: exam.json_data,
      revisions,
    });
  });

  router.put('/:level/:examId/part/:part', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    const level = String(req.params.level);
    const examId = String(req.params.examId);
    const part = Number(req.params.part);
    const json = req.body?.json;
    if (!json) return res.status(400).json({ message: 'Missing json' });

    const exam = await prisma.jlptExam.findFirst({ where: { level, exam_id: examId, part } });
    if (!exam) return res.status(404).json({ message: 'Exam part not found' });

    await prisma.jlptExamRevision.create({
      data: {
        level,
        exam_id: examId,
        part,
        editor_id: BigInt(admin.id),
        note: req.body?.note || null,
        json_data: exam.json_data as any,
      },
    });

    await prisma.jlptExam.update({
      where: {
        level_exam_id_part: {
          level,
          exam_id: examId,
          part,
        },
      },
      data: { json_data: json },
    });

    return res.json({ updated: true });
  });

  router.post('/:level/:examId/part/:part/restore/:revisionId', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    const level = String(req.params.level);
    const examId = String(req.params.examId);
    const part = Number(req.params.part);
    const revisionId = Number(req.params.revisionId);

    const exam = await prisma.jlptExam.findFirst({ where: { level, exam_id: examId, part } });
    if (!exam) return res.status(404).json({ message: 'Exam part not found' });
    const revision = await prisma.jlptExamRevision.findUnique({ where: { id: BigInt(revisionId) } });
    if (!revision) return res.status(404).json({ message: 'Revision not found' });

    await prisma.jlptExamRevision.create({
      data: {
        level,
        exam_id: examId,
        part,
        editor_id: BigInt(admin.id),
        note: 'restore',
        json_data: exam.json_data as any,
      },
    });

    await prisma.jlptExam.update({
      where: {
        level_exam_id_part: {
          level,
          exam_id: examId,
          part,
        },
      },
      data: { json_data: revision.json_data as any },
    });
    return res.json({ restored: true });
  });

  return router;
}
