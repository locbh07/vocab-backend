import { Router, Request, Response } from 'express';
import { readContactSettings } from '../lib/contactStore';
import { resolveRequestLanguage, translateContactSettings, translateContactChannels } from '../lib/contentTranslation';

export function createContactRouter() {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const contact = await readContactSettings(false);
    const language = resolveRequestLanguage(req);
    const [translatedSettings, translatedChannels] = await Promise.all([
      translateContactSettings(contact, language),
      translateContactChannels(contact.channels, language),
    ]);
    res.setHeader('Vary', 'X-Language');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    return res.json({ ...contact, ...translatedSettings, channels: translatedChannels });
  });

  return router;
}
