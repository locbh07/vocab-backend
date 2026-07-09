import { Request, Response, NextFunction } from 'express';

type ApiShieldOptions = {
  windowMs: number;
  maxRequestsPerIp: number;
  maxRequestsPerUser: number;
  maxDistinctUsersPerIp: number;
  distinctWindowMs: number;
  blockMs: number;
  keyPrefix?: string;
  suspiciousScoreWindowMs?: number;
  suspiciousScoreThreshold?: number;
  maxDistinctTargetsPerIp?: number;
  rapidRequestIntervalMs?: number;
  rapidRequestBurst?: number;
  maxSequentialNumericTargets?: number;
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

type SuspiciousBucket = {
  score: number;
  resetAt: number;
  reasons: Record<string, number>;
};

type TargetBucket = {
  targets: Set<string>;
  resetAt: number;
};

type RapidBucket = {
  lastAt: number;
  hits: number;
  resetAt: number;
};

type SequenceBucket = {
  lastValue: number | null;
  hits: number;
  resetAt: number;
};

const ipCounters = new Map<string, CounterBucket>();
const userCounters = new Map<string, CounterBucket>();
const distinctUserCounters = new Map<string, DistinctUsersBucket>();
const blockedIps = new Map<string, BlockBucket>();
const suspiciousCounters = new Map<string, SuspiciousBucket>();
const targetCounters = new Map<string, TargetBucket>();
const rapidCounters = new Map<string, RapidBucket>();
const sequenceCounters = new Map<string, SequenceBucket>();

let requestCount = 0;

function getClientIp(req: Request): string {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function normalizePath(req: Request): string {
  const rawUrl = String(req.originalUrl || req.url || '');
  const pathOnly = rawUrl.split('?')[0] || '/';
  return pathOnly.replace(/\/+/g, '/').toLowerCase();
}

function getTargetSignature(req: Request): string {
  const rawUrl = String(req.originalUrl || req.url || '');
  const [pathOnly, queryString = ''] = rawUrl.split('?');
  const params = new URLSearchParams(queryString);
  const queryParts: string[] = [];
  for (const [key, value] of params.entries()) {
    const normalizedValue = /^\d+$/.test(value) ? ':n' : value.slice(0, 48).toLowerCase();
    queryParts.push(`${key.toLowerCase()}=${normalizedValue}`);
  }
  queryParts.sort();
  return `${req.method}:${String(pathOnly || '/').toLowerCase()}?${queryParts.join('&')}`;
}

function getNumericTarget(req: Request): number | null {
  const pathNumbers = normalizePath(req)
    .split('/')
    .map((part) => Number(part))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (pathNumbers.length) return pathNumbers[pathNumbers.length - 1];

  const query = req.query as Record<string, unknown>;
  for (const key of ['id', 'vocabId', 'vocabularyId', 'wordId', 'page', 'offset']) {
    const value = Number(query[key]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

function isSuspiciousUserAgent(req: Request): boolean {
  const userAgent = String(req.header('user-agent') || '').trim().toLowerCase();
  if (!userAgent) return true;
  return /(?:curl|wget|python|requests|scrapy|httpclient|go-http-client|java\/|okhttp|headless|selenium|playwright|puppeteer|phantomjs|postman|insomnia|libwww-perl)/i.test(
    userAgent,
  );
}

function isLargeCollectionRequest(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const path = normalizePath(req);
  if (path.endsWith('/vocabulary/all')) return true;
  if (path.endsWith('/listening/videos')) {
    const limit = Number((req.query as Record<string, unknown>)?.limit || 0);
    return !Number.isFinite(limit) || limit >= 1000;
  }
  return false;
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
  for (const [key, bucket] of suspiciousCounters.entries()) {
    if (now >= bucket.resetAt) suspiciousCounters.delete(key);
  }
  for (const [key, bucket] of targetCounters.entries()) {
    if (now >= bucket.resetAt) targetCounters.delete(key);
  }
  for (const [key, bucket] of rapidCounters.entries()) {
    if (now >= bucket.resetAt) rapidCounters.delete(key);
  }
  for (const [key, bucket] of sequenceCounters.entries()) {
    if (now >= bucket.resetAt) sequenceCounters.delete(key);
  }
}

function blockIp(prefix: string, clientIp: string, now: number, blockMs: number, reason: string) {
  blockedIps.set(`${prefix}:block:${clientIp}`, { until: now + blockMs, reason });
  console.warn(`[api-shield] blocked ip=${clientIp} scope=${prefix} reason=${reason} blockMs=${blockMs}`);
}

function addSuspicion(
  prefix: string,
  clientIp: string,
  now: number,
  windowMs: number,
  score: number,
  reason: string,
): SuspiciousBucket {
  const key = `${prefix}:suspect:${clientIp}`;
  const current = suspiciousCounters.get(key);
  const bucket =
    !current || now >= current.resetAt
      ? { score: 0, resetAt: now + windowMs, reasons: {} }
      : current;

  bucket.score += score;
  bucket.reasons[reason] = (bucket.reasons[reason] || 0) + score;
  suspiciousCounters.set(key, bucket);
  return bucket;
}

function topReason(reasons: Record<string, number>): string {
  let bestReason = 'suspicious_request_pattern';
  let bestScore = 0;
  for (const [reason, score] of Object.entries(reasons)) {
    if (score > bestScore) {
      bestReason = reason;
      bestScore = score;
    }
  }
  return bestReason;
}

export function createApiShield(options: ApiShieldOptions) {
  const windowMs = Math.max(1_000, Number(options.windowMs || 60_000));
  const maxRequestsPerIp = Math.max(1, Number(options.maxRequestsPerIp || 240));
  const maxRequestsPerUser = Math.max(1, Number(options.maxRequestsPerUser || 180));
  const maxDistinctUsersPerIp = Math.max(1, Number(options.maxDistinctUsersPerIp || 6));
  const distinctWindowMs = Math.max(5_000, Number(options.distinctWindowMs || 300_000));
  const blockMs = Math.max(10_000, Number(options.blockMs || 600_000));
  const keyPrefix = String(options.keyPrefix || 'api-shield');
  const suspiciousScoreWindowMs = Math.max(10_000, Number(options.suspiciousScoreWindowMs || 300_000));
  const suspiciousScoreThreshold = Math.max(1, Number(options.suspiciousScoreThreshold || 14));
  const maxDistinctTargetsPerIp = Math.max(5, Number(options.maxDistinctTargetsPerIp || 80));
  const rapidRequestIntervalMs = Math.max(25, Number(options.rapidRequestIntervalMs || 250));
  const rapidRequestBurst = Math.max(3, Number(options.rapidRequestBurst || 18));
  const maxSequentialNumericTargets = Math.max(3, Number(options.maxSequentialNumericTargets || 12));

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

    if (isSuspiciousUserAgent(req)) {
      const bucket = addSuspicion(keyPrefix, clientIp, now, suspiciousScoreWindowMs, 3, 'suspicious_user_agent');
      if (bucket.score >= suspiciousScoreThreshold) {
        blockIp(keyPrefix, clientIp, now, blockMs, topReason(bucket.reasons));
        res.setHeader('Retry-After', String(Math.ceil(blockMs / 1000)));
        return res.status(429).json({ message: 'Unusual access pattern detected. Please retry later.' });
      }
    }

    if (isLargeCollectionRequest(req)) {
      const bucket = addSuspicion(keyPrefix, clientIp, now, suspiciousScoreWindowMs, 2, 'large_collection_scan');
      if (bucket.score >= suspiciousScoreThreshold) {
        blockIp(keyPrefix, clientIp, now, blockMs, topReason(bucket.reasons));
        res.setHeader('Retry-After', String(Math.ceil(blockMs / 1000)));
        return res.status(429).json({ message: 'Unusual collection access detected. Please retry later.' });
      }
    }

    const targetKey = `${keyPrefix}:targets:${clientIp}`;
    const currentTargets = targetCounters.get(targetKey);
    const targetBucket =
      !currentTargets || now >= currentTargets.resetAt
        ? { targets: new Set<string>(), resetAt: now + suspiciousScoreWindowMs }
        : currentTargets;
    targetBucket.targets.add(getTargetSignature(req));
    targetCounters.set(targetKey, targetBucket);
    if (targetBucket.targets.size > maxDistinctTargetsPerIp) {
      blockIp(keyPrefix, clientIp, now, blockMs, 'too_many_distinct_targets');
      res.setHeader('Retry-After', String(Math.ceil(blockMs / 1000)));
      return res.status(429).json({ message: 'Unusual access pattern detected. Please retry later.' });
    }

    const rapidKey = `${keyPrefix}:rapid:${clientIp}`;
    const rapidBucket = rapidCounters.get(rapidKey) || { lastAt: 0, hits: 0, resetAt: now + suspiciousScoreWindowMs };
    if (now >= rapidBucket.resetAt) {
      rapidBucket.hits = 0;
      rapidBucket.resetAt = now + suspiciousScoreWindowMs;
    }
    rapidBucket.hits = rapidBucket.lastAt > 0 && now - rapidBucket.lastAt < rapidRequestIntervalMs ? rapidBucket.hits + 1 : 0;
    rapidBucket.lastAt = now;
    rapidCounters.set(rapidKey, rapidBucket);
    if (rapidBucket.hits >= rapidRequestBurst) {
      const bucket = addSuspicion(keyPrefix, clientIp, now, suspiciousScoreWindowMs, 4, 'rapid_request_burst');
      rapidBucket.hits = 0;
      if (bucket.score >= suspiciousScoreThreshold) {
        blockIp(keyPrefix, clientIp, now, blockMs, topReason(bucket.reasons));
        res.setHeader('Retry-After', String(Math.ceil(blockMs / 1000)));
        return res.status(429).json({ message: 'Request rate looks automated. Please retry later.' });
      }
    }

    const numericTarget = getNumericTarget(req);
    if (numericTarget !== null) {
      const sequenceKey = `${keyPrefix}:seq:${clientIp}:${normalizePath(req).replace(/\d+/g, ':n')}`;
      const sequenceBucket =
        sequenceCounters.get(sequenceKey) || { lastValue: null, hits: 0, resetAt: now + suspiciousScoreWindowMs };
      if (now >= sequenceBucket.resetAt) {
        sequenceBucket.lastValue = null;
        sequenceBucket.hits = 0;
        sequenceBucket.resetAt = now + suspiciousScoreWindowMs;
      }
      sequenceBucket.hits =
        sequenceBucket.lastValue !== null && Math.abs(numericTarget - sequenceBucket.lastValue) === 1
          ? sequenceBucket.hits + 1
          : 0;
      sequenceBucket.lastValue = numericTarget;
      sequenceCounters.set(sequenceKey, sequenceBucket);
      if (sequenceBucket.hits >= maxSequentialNumericTargets) {
        blockIp(keyPrefix, clientIp, now, blockMs, 'sequential_numeric_scan');
        res.setHeader('Retry-After', String(Math.ceil(blockMs / 1000)));
        return res.status(429).json({ message: 'Sequential scan detected. Please retry later.' });
      }
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
