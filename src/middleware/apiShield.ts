import { Request, Response, NextFunction } from 'express';

type ApiShieldOptions = {
  windowMs: number;
  maxRequestsPerIp: number;
  maxRequestsPerUser: number;
  maxDistinctUsersPerIp: number;
  distinctWindowMs: number;
  blockMs: number;
  keyPrefix?: string;
};

type CounterBucket = {
  count: number;
  resetAt: number;
};

type DistinctUsersBucket = {
  ids: Set<string>;
  resetAt: number;
};

type BlockBucket = {
  until: number;
  reason: string;
};

const ipCounters = new Map<string, CounterBucket>();
const userCounters = new Map<string, CounterBucket>();
const distinctUserCounters = new Map<string, DistinctUsersBucket>();
const blockedIps = new Map<string, BlockBucket>();

let requestCount = 0;

function getClientIp(req: Request): string {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function isLocalRequest(req: Request, clientIp: string): boolean {
  const host = String(req.hostname || req.header('host') || '').toLowerCase();
  if (host.includes('localhost') || host.startsWith('127.0.0.1')) return true;

  const ip = String(clientIp || '').toLowerCase();
  return (
    ip === '::1' ||
    ip === '127.0.0.1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('::ffff:127.')
  );
}

function toUserIdString(value: unknown): string | null {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return String(Math.trunc(num));
}

function extractUserId(req: Request): string | null {
  const fromQuery = toUserIdString((req.query as Record<string, unknown>)?.userId);
  if (fromQuery) return fromQuery;

  const fromQuerySnake = toUserIdString((req.query as Record<string, unknown>)?.user_id);
  if (fromQuerySnake) return fromQuerySnake;

  const body = (req.body || {}) as Record<string, unknown>;
  const fromBody = toUserIdString(body.userId);
  if (fromBody) return fromBody;

  const fromBodySnake = toUserIdString(body.user_id);
  if (fromBodySnake) return fromBodySnake;

  const fromHeader = toUserIdString(req.header('x-user-id'));
  if (fromHeader) return fromHeader;

  return null;
}

function bumpCounter(store: Map<string, CounterBucket>, key: string, now: number, windowMs: number): CounterBucket {
  const current = store.get(key);
  if (!current || now >= current.resetAt) {
    const next = { count: 1, resetAt: now + windowMs };
    store.set(key, next);
    return next;
  }
  current.count += 1;
  store.set(key, current);
  return current;
}

function getDistinctUsersBucket(
  store: Map<string, DistinctUsersBucket>,
  key: string,
  now: number,
  windowMs: number,
): DistinctUsersBucket {
  const current = store.get(key);
  if (!current || now >= current.resetAt) {
    const next = { ids: new Set<string>(), resetAt: now + windowMs };
    store.set(key, next);
    return next;
  }
  return current;
}

function cleanupExpired(now: number) {
  for (const [key, bucket] of ipCounters.entries()) {
    if (now >= bucket.resetAt) ipCounters.delete(key);
  }
  for (const [key, bucket] of userCounters.entries()) {
    if (now >= bucket.resetAt) userCounters.delete(key);
  }
  for (const [key, bucket] of distinctUserCounters.entries()) {
    if (now >= bucket.resetAt) distinctUserCounters.delete(key);
  }
  for (const [key, bucket] of blockedIps.entries()) {
    if (now >= bucket.until) blockedIps.delete(key);
  }
}

function blockIp(prefix: string, clientIp: string, now: number, blockMs: number, reason: string) {
  blockedIps.set(`${prefix}:block:${clientIp}`, { until: now + blockMs, reason });
}

export function createApiShield(options: ApiShieldOptions) {
  const windowMs = Math.max(1_000, Number(options.windowMs || 60_000));
  const maxRequestsPerIp = Math.max(1, Number(options.maxRequestsPerIp || 240));
  const maxRequestsPerUser = Math.max(1, Number(options.maxRequestsPerUser || 180));
  const maxDistinctUsersPerIp = Math.max(1, Number(options.maxDistinctUsersPerIp || 6));
  const distinctWindowMs = Math.max(5_000, Number(options.distinctWindowMs || 300_000));
  const blockMs = Math.max(10_000, Number(options.blockMs || 600_000));
  const keyPrefix = String(options.keyPrefix || 'api-shield');

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    requestCount += 1;
    if (requestCount % 500 === 0) cleanupExpired(now);

    const clientIp = getClientIp(req);
    if (isLocalRequest(req, clientIp)) return next();

    const blockKey = `${keyPrefix}:block:${clientIp}`;
    const blocked = blockedIps.get(blockKey);
    if (blocked && now < blocked.until) {
      const retryAfterSec = Math.max(1, Math.ceil((blocked.until - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        message: 'Request pattern flagged as unusual. Please retry later.',
        reason: blocked.reason,
      });
    }
    if (blocked && now >= blocked.until) {
      blockedIps.delete(blockKey);
    }

    const ipKey = `${keyPrefix}:ip:${clientIp}`;
    const ipBucket = bumpCounter(ipCounters, ipKey, now, windowMs);
    if (ipBucket.count > maxRequestsPerIp) {
      blockIp(keyPrefix, clientIp, now, blockMs, 'ip_rate_limit_exceeded');
      res.setHeader('Retry-After', String(Math.ceil(blockMs / 1000)));
      return res.status(429).json({
        message: 'Too many requests from this IP. Please retry later.',
      });
    }

    const userId = extractUserId(req);
    if (userId) {
      const userKey = `${keyPrefix}:user:${clientIp}:${userId}`;
      const userBucket = bumpCounter(userCounters, userKey, now, windowMs);
      if (userBucket.count > maxRequestsPerUser) {
        blockIp(keyPrefix, clientIp, now, blockMs, 'user_rate_limit_exceeded');
        res.setHeader('Retry-After', String(Math.ceil(blockMs / 1000)));
        return res.status(429).json({
          message: 'Too many requests for this account from one IP. Please retry later.',
        });
      }

      const distinctKey = `${keyPrefix}:distinct:${clientIp}`;
      const distinctBucket = getDistinctUsersBucket(distinctUserCounters, distinctKey, now, distinctWindowMs);
      distinctBucket.ids.add(userId);
      distinctUserCounters.set(distinctKey, distinctBucket);
      if (distinctBucket.ids.size > maxDistinctUsersPerIp) {
        blockIp(keyPrefix, clientIp, now, blockMs, 'too_many_user_ids_per_ip');
        res.setHeader('Retry-After', String(Math.ceil(blockMs / 1000)));
        return res.status(429).json({
          message: 'Unusual access pattern detected. Please retry later.',
        });
      }
    }

    return next();
  };
}
