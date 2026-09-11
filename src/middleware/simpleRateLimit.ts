import { Request, Response, NextFunction } from 'express';
import { getClientIp, isLocalRequest, canonicalRateScope, authenticatedUserId } from '../lib/requestIdentity';
import { consumeRateBudget } from '../lib/rateLimitStore';

type RateLimitOptions = { windowMs: number; max: number; keyPrefix?: string };

export function createSimpleRateLimit(options: RateLimitOptions) {
  const windowMs = Math.max(1000, options.windowMs);
  const max = Math.max(1, options.max);
  const scope = canonicalRateScope(options.keyPrefix || 'global');
  return async (req: Request, res: Response, next: NextFunction) => {
    if (isLocalRequest(req)) return next();
    try {
      const userId = authenticatedUserId(req);
      const budgets = await Promise.all([
        consumeRateBudget(`${scope}:ip:${getClientIp(req)}`, 1, max, windowMs),
        ...(userId ? [consumeRateBudget(`${scope}:user:${userId}`, 1, max, windowMs)] : []),
      ]);
      const blocked = budgets.filter((budget) => !budget.allowed);
      if (blocked.length) {
        res.set('Retry-After', String(Math.max(...blocked.map((budget) => budget.retryAfter))));
        return res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.' });
      }
      return next();
    } catch {
      res.set('Retry-After', '30');
      return res.status(503).json({ code: 'RATE_LIMIT_UNAVAILABLE', message: 'Please retry shortly.' });
    }
  };
}
