import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

type Bucket = { count: number; resetAt: number };
const memory = new Map<string, Bucket>();
let calls = 0;

function hashBucketKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

async function maybeCleanupPostgres(previousCalls: number, nextCalls: number) {
  if (Math.floor(previousCalls / 500) === Math.floor(nextCalls / 500)) return;
  await prisma.$executeRaw`DELETE FROM api_rate_bucket WHERE key IN
    (SELECT key FROM api_rate_bucket WHERE reset_at < NOW() ORDER BY reset_at LIMIT 500)`;
}

// Atomic reservations across serverless instances; memory is for development.
export async function consumeRateBudget(key: string, cost: number, max: number, windowMs: number) {
  const store = process.env.API_RATE_LIMIT_STORE || (process.env.NODE_ENV === 'production' ? 'postgres' : 'memory');
  const now = Date.now();
  let bucket: Bucket;
  if (store === 'postgres') {
    const bucketKey = hashBucketKey(key);
    const rows = await prisma.$queryRaw<Array<{ count: number; reset_at: Date }>>`
      INSERT INTO api_rate_bucket (key, count, reset_at)
      VALUES (${bucketKey}, ${cost}, NOW() + ${windowMs} * INTERVAL '1 millisecond')
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN api_rate_bucket.reset_at <= NOW() THEN ${cost}
          ELSE LEAST(api_rate_bucket.count + ${cost}, ${max + cost}) END,
        reset_at = CASE WHEN api_rate_bucket.reset_at <= NOW()
          THEN NOW() + ${windowMs} * INTERVAL '1 millisecond' ELSE api_rate_bucket.reset_at END
      RETURNING count, reset_at
    `;
    bucket = { count: rows[0].count, resetAt: new Date(rows[0].reset_at).getTime() };
    const previousCalls = calls;
    calls += 1;
    await maybeCleanupPostgres(previousCalls, calls);
  } else if (store === 'memory') {
    if (++calls % 100 === 0 || memory.size >= 10000) {
      for (const [entry, value] of memory) if (value.resetAt <= now) memory.delete(entry);
    }
    const previous = memory.get(key);
    if (!previous && memory.size >= 10000) throw new Error('Rate limit store at capacity');
    bucket = previous && previous.resetAt > now
      ? { ...previous, count: Math.min(previous.count + cost, max + cost) }
      : { count: cost, resetAt: now + windowMs };
    memory.set(key, bucket);
  } else {
    throw new Error('Invalid API_RATE_LIMIT_STORE');
  }
  return { allowed: bucket.count <= max, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}

// Reserve several related budgets in one PostgreSQL statement. Authenticated requests
// normally consume both an IP and a user budget; doing those as separate UPSERTs doubles
// the database round-trips on every API call and amplifies lock contention during page-load
// request bursts. The single-key function remains available for callers/tests that need it.
export async function consumeRateBudgets(keys: string[], cost: number, max: number, windowMs: number) {
  const uniqueKeys = [...new Set(keys)];
  if (!uniqueKeys.length) return [];

  const store = process.env.API_RATE_LIMIT_STORE || (process.env.NODE_ENV === 'production' ? 'postgres' : 'memory');
  if (store !== 'postgres') {
    return Promise.all(uniqueKeys.map((key) => consumeRateBudget(key, cost, max, windowMs)));
  }

  const now = Date.now();
  const hashedByKey = new Map(uniqueKeys.map((key) => [key, hashBucketKey(key)]));
  const values = Prisma.join(
    uniqueKeys.map((key) => Prisma.sql`(${hashedByKey.get(key)}, ${cost}, NOW() + ${windowMs} * INTERVAL '1 millisecond')`),
  );
  const rows = await prisma.$queryRaw<Array<{ key: string; count: number; reset_at: Date }>>(Prisma.sql`
    INSERT INTO api_rate_bucket (key, count, reset_at)
    VALUES ${values}
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN api_rate_bucket.reset_at <= NOW() THEN ${cost}
        ELSE LEAST(api_rate_bucket.count + ${cost}, ${max + cost}) END,
      reset_at = CASE WHEN api_rate_bucket.reset_at <= NOW()
        THEN NOW() + ${windowMs} * INTERVAL '1 millisecond' ELSE api_rate_bucket.reset_at END
    RETURNING key, count, reset_at
  `);
  const rowByHash = new Map(rows.map((row) => [row.key, row]));
  const previousCalls = calls;
  calls += uniqueKeys.length;
  await maybeCleanupPostgres(previousCalls, calls);

  return uniqueKeys.map((key) => {
    const row = rowByHash.get(hashedByKey.get(key)!);
    if (!row) throw new Error('Rate-limit reservation did not return a bucket');
    const resetAt = new Date(row.reset_at).getTime();
    return {
      allowed: row.count <= max,
      retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  });
}
