import { Request, Response } from 'express';
import { authenticatedUserId, getClientIp, isLocalRequest } from '../lib/requestIdentity';
import { consumeRateBudget } from '../lib/rateLimitStore';

// Reserve the requested page size, including repeat reads, for all plans.
export async function reserveContentBudget(req: Request, res: Response, cost: number): Promise<boolean> {
  if (isLocalRequest(req)) return true;
  const userId = authenticatedUserId(req);
  const configured = Number(process.env.CONTENT_ROWS_PER_HOUR || 15000);
  const max = Number.isSafeInteger(configured) && configured > 0 ? configured : 15000;
  try {
    const budgets = await Promise.all([
      consumeRateBudget(`content:ip:${getClientIp(req)}`, cost, max * 3, 3600000),
      consumeRateBudget(`content:${userId ? `user:${userId}` : `guest:${getClientIp(req)}`}`, cost, max, 3600000),
    ]);
    const blocked = budgets.filter((budget) => !budget.allowed);
    if (!blocked.length) return true;
    res.set('Retry-After', String(Math.max(...blocked.map((budget) => budget.retryAfter))));
    res.status(429).json({ code: 'CONTENT_RATE_LIMITED', message: 'Content access is temporarily limited. Please retry later.' });
  } catch {
    res.set('Retry-After', '30');
    res.status(503).json({ code: 'RATE_LIMIT_UNAVAILABLE', message: 'Please retry shortly.' });
  }
  return false;
}
