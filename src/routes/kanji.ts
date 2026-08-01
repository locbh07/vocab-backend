import { Request, Response, Router } from 'express';
import { listKanjiCompounds } from '../lib/kanjiCompounds';
import { resolveRequestLanguage } from '../lib/contentTranslation';

export function createKanjiRouter() {
  const router = Router();

  router.get('/compounds/:kanji', async (req: Request, res: Response) => {
    const kanji = String(req.params.kanji || '').trim();
    const limit = Number(req.query.limit || 30);
    if (!kanji) return res.status(400).json({ message: 'Missing kanji' });
    const language = resolveRequestLanguage(req);
    const compounds = await listKanjiCompounds({ kanji, limit, language });
    return res.json({
      kanji,
      count: compounds.length,
      compounds,
    });
  });

  router.get('/compounds', async (req: Request, res: Response) => {
    const kanji = String(req.query.kanji || '').trim();
    const limit = Number(req.query.limit || 30);
    if (!kanji) return res.status(400).json({ message: 'Missing kanji query' });
    const language = resolveRequestLanguage(req);
    const compounds = await listKanjiCompounds({ kanji, limit, language });
    return res.json({
      kanji,
      count: compounds.length,
      compounds,
    });
  });

  return router;
}
