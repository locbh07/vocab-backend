import { NextFunction, Request, Response } from 'express';
import { resolveContentAccess } from '../lib/contentAccess';

export async function contentGuard(req: Request, _res: Response, next: NextFunction) {
  const access = await resolveContentAccess(req);
  req.isPremium = access.isPremium;
  req.premiumUserId = access.userId;
  next();
}
