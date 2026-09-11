import { createHash } from 'crypto';
import { prisma } from './prisma';

type Bucket = { count: number; resetAt: number };
const memory = new Map<string, Bucket>();
let calls = 0;

// Atomic reservations across serverless instances; memory is for development.
export async function consumeRateBudget(key: string, cost: number, max: number, windowMs: number) {
  const store = process.env.API_RATE_LIMIT_STORE || (process.env.NODE_ENV === 'production' ? 'postgres' : 'memory');
  const now = Date.now();
  let bucket: Bucket;
  if (store === 'postgres') {
    const bucketKey = createHash('sha256').update(key).digest('hex');
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
    if (++calls % 500 === 0) {
      await prisma.$executeRaw`DELETE FROM api_rate_bucket WHERE key IN
        (SELECT key FROM api_rate_bucket WHERE reset_at < NOW() ORDER BY reset_at LIMIT 500)`;
    }
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
