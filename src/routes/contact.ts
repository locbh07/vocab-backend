import { Router, Response } from 'express';
import { readContactSettings } from '../lib/contactStore';

export function createContactRouter() {
  const router = Router();

  router.get('/', async (_req, res: Response) => {
    const contact = await readContactSettings(false);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    return res.json(contact);
  });

  return router;
}
