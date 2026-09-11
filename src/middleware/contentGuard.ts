import { NextFunction, Request, Response } from 'express';
import { resolveContentAccess } from '../lib/contentAccess';

export async function contentGuard(req: Request, res: Response, next: NextFunction) {
  res.set('Cache-Control', 'private, no-store');
  const access = await resolveContentAccess(req);
  req.isPremium = access.isPremium;
  req.premiumUserId = access.userId;
  next();
}
