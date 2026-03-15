import { Request, Response, NextFunction } from 'express';

type RateLimitOptions = {
  windowMs: number;
  max: number;
  keyPrefix?: string;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

function getClientIp(req: Request): string {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function createSimpleRateLimit(options: RateLimitOptions) {
  const windowMs = Math.max(1_000, Number(options.windowMs || 60_000));
  const max = Math.max(1, Number(options.max || 60));
  const keyPrefix = String(options.keyPrefix || 'global');

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const clientIp = getClientIp(req);
    const key = `${keyPrefix}:${clientIp}`;
    const current = buckets.get(key);

    if (!current || now >= current.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (current.count >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        message: 'Too many requests. Please retry later.',
      });
    }

    current.count += 1;
    buckets.set(key, current);
    return next();
  };
}

