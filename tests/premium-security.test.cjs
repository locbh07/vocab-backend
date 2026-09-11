const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.API_RATE_LIMIT_STORE = 'memory';
process.env.JWT_SECRET = 'synthetic-premium-test-secret';
// Never use a workspace environment/database for these unit tests.
process.env.DATABASE_URL = 'postgresql://unused@127.0.0.1:1/unused';
const { signAuthToken } = require('../dist/lib/authToken');
const { getClientIp, authenticatedUserId, isLocalRequest } = require('../dist/lib/requestIdentity');
const { createSimpleRateLimit } = require('../dist/middleware/simpleRateLimit');
const { vocabularyPagination } = require('../dist/lib/vocabularyPagination');
const { hasActivePremium } = require('../dist/lib/contentAccess');
const { consumeRateBudget } = require('../dist/lib/rateLimitStore');

function request(headers = {}, ip = '203.0.113.4') {
  return { ip, socket: { remoteAddress: ip }, header: (key) => headers[key.toLowerCase()] };
}
function response() {
  return { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}

test('client-supplied IP, localhost and user hints do not determine identity', () => {
  const req = request({ 'x-forwarded-for': '127.0.0.1', host: 'localhost', 'x-user-id': '99' });
  req.query = { userId: 99 };
  req.body = { userId: 99 };
  assert.equal(getClientIp(req), '203.0.113.4');
  assert.equal(authenticatedUserId(req), null);
  assert.equal(isLocalRequest(req), false);
  assert.equal(isLocalRequest(request({}, '127.0.0.1')), false);
  req.header = (name) => name.toLowerCase() === 'authorization' ? `Bearer ${signAuthToken({ userId: 42 })}` : undefined;
  assert.equal(authenticatedUserId(req), '42');
});

test('route aliases share a rate budget', async () => {
  const primary = createSimpleRateLimit({ max: 2, windowMs: 60000, keyPrefix: 'alias-test' });
  const alias = createSimpleRateLimit({ max: 2, windowMs: 60000, keyPrefix: 'api-alias-test' });
  let passed = 0;
  await primary(request(), response(), () => passed++);
  await alias(request(), response(), () => passed++);
  const blocked = response();
  await primary(request({ 'x-forwarded-for': '198.51.100.9' }), blocked, () => passed++);
  assert.equal(passed, 2);
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
});

test('a signed account cannot reset its budget by rotating IPs', async () => {
  const limiter = createSimpleRateLimit({ max: 1, windowMs: 60000, keyPrefix: 'user-test' });
  const headers = { authorization: `Bearer ${signAuthToken({ userId: 42 })}` };
  let passed = 0;
  await limiter(request(headers, '203.0.113.1'), response(), () => passed++);
  const blocked = response();
  await limiter(request(headers, '203.0.113.2'), blocked, () => passed++);
  assert.equal(passed, 1);
  assert.equal(blocked.statusCode, 429);
});

test('content budgets charge page volume and concurrent requests', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => consumeRateBudget('volume-test', 500, 1500, 60000)));
  assert.equal(results.filter((item) => item.allowed).length, 3);
});

test('pagination always bounds the query and rejects malformed offsets', () => {
  assert.deepEqual(vocabularyPagination({}), { take: 250, skip: 0 });
  assert.deepEqual(vocabularyPagination({ limit: '50000', offset: '500' }), { take: 500, skip: 500 });
  for (const limit of ['0', '-1', 'NaN', '2.5', 'Infinity', ['1', '2']]) assert.equal(vocabularyPagination({ limit }), null);
  for (const offset of ['-1', '1.5', '100001', 'NaN']) assert.equal(vocabularyPagination({ offset }), null);
});

test('expired, missing and malformed Premium expiry never grant plan access', () => {
  for (const premiumValidUntil of [null, 'invalid', '2000-01-01']) {
    assert.equal(hasActivePremium({ role: 'USER', plan: 'PREMIUM', premiumValidUntil }), false);
  }
  assert.equal(hasActivePremium({ role: 'USER', plan: 'PREMIUM', premiumValidUntil: '9999-12-31' }), true);
});
