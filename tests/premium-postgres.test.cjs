const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

// This integration suite requires a disposable, schema-initialized database.
// Exact host/port/name guard prevents accidental staging/production mutations.
const target = process.env.PREMIUM_TEST_DATABASE_URL;
if (!target || new URL(target).hostname !== '127.0.0.1' || new URL(target).port !== '55439' || new URL(target).pathname !== '/postgres') {
  throw new Error('Set PREMIUM_TEST_DATABASE_URL to the disposable local PostgreSQL on port 55439');
}
process.env.DATABASE_URL = target;
process.env.DIRECT_URL = target;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'synthetic-premium-test-secret';
process.env.API_RATE_LIMIT_STORE = 'postgres';
process.env.PREMIUM_MONTHLY_DAYS = '30';
const { prisma } = require('../dist/lib/prisma');
// No test may send notifications to real services.
require('../dist/lib/telegram').notifyTelegram = async () => {};
const express = require('express');
require('express-async-errors');
const { signAuthToken } = require('../dist/lib/authToken');
const { createManualPaymentRouter, createAdminManualPaymentRouter } = require('../dist/routes/manualPayments');
const { consumeRateBudget } = require('../dist/lib/rateLimitStore');
const { jsonSafe } = require('../dist/lib/jsonSafe');
const { createVocabularyRouter } = require('../dist/routes/vocabulary');
const { createMailboxRouter } = require('../dist/routes/mailbox');
let server, base, admin, owner, stranger;
const runId = Date.now();
const auth = (user) => ({ Authorization: `Bearer ${signAuthToken({ userId: Number(user.id) })}` });

test.before(async () => {
  const makeUser = (name, role) => prisma.userAccount.create({ data: {
    username: `${name}-${runId}`, fullname: name, email: `${name}-${runId}@example.invalid`, passwordhash: 'not-a-password', role,
  } });
  admin = await makeUser('admin', 'ADMIN');
  owner = await makeUser('owner', 'USER');
  stranger = await makeUser('stranger', 'USER');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const json = res.json.bind(res); res.json = (value) => json(jsonSafe(value)); next(); });
  app.use('/manual-payments', createManualPaymentRouter());
  app.use('/mailbox', createMailboxRouter());
  app.use('/vocabulary', createVocabularyRouter());
  app.use('/admin/manual-payments', createAdminManualPaymentRouter());
  app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  // Initialize the legacy payment tables on the disposable database only.
  assert.equal((await fetch(`${base}/manual-payments/requests/mine`, { headers: auth(owner) })).status, 200);
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function payment(plan = 'monthly') {
  const code = `test-${runId}-${Math.random().toString(36).slice(2)}`;
  const [row] = await prisma.$queryRaw`INSERT INTO manual_payment_request
    (user_id, payment_code, provider, billing_period, amount, currency, transfer_content)
    VALUES (${owner.id}, ${code}, 'MSB', ${plan}, 99000, 'VND', ${code}) RETURNING id`;
  return row.id.toString();
}
const approve = (id) => fetch(`${base}/admin/manual-payments/${id}/approve`, { method: 'POST', headers: auth(admin) });
const reportPayment = (id) => fetch(`${base}/manual-payments/requests/${id}/mark-paid`, { method: 'POST', headers: auth(owner) });

test('migration SQL creates the backend-only counter table', async () => {
  const sql = readFileSync(path.join(__dirname, '../prisma/migrations/20260910120000_add_api_rate_bucket/migration.sql'), 'utf8');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('DROP SCHEMA IF EXISTS premium_migration_test CASCADE');
    await tx.$executeRawUnsafe('CREATE SCHEMA premium_migration_test');
    await tx.$executeRawUnsafe('SET LOCAL search_path TO premium_migration_test');
    for (const statement of sql.split(';').map((item) => item.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
    const [row] = await tx.$queryRaw`SELECT relrowsecurity FROM pg_class WHERE oid = 'premium_migration_test.api_rate_bucket'::regclass`;
    assert.equal(row.relrowsecurity, true);
  });
});

test('PostgreSQL reservations remain atomic across concurrent calls and reset after expiry', async () => {
  const results = await Promise.all(Array.from({ length: 30 }, () => consumeRateBudget(`postgres-${runId}`, 1, 7, 60000)));
  assert.equal(results.filter((item) => item.allowed).length, 7);
  await prisma.$executeRaw`UPDATE api_rate_bucket SET reset_at = NOW() - INTERVAL '1 second'`;
  assert.equal((await consumeRateBudget(`postgres-${runId}`, 1, 7, 60000)).allowed, true);
});

test('manual status is private and reporting a transfer does not grant Premium', async () => {
  const id = await payment();
  assert.equal((await fetch(`${base}/manual-payments/requests/${id}`)).status, 401);
  assert.equal((await fetch(`${base}/manual-payments/requests/${id}`, { headers: auth(stranger) })).status, 404);
  const report = await fetch(`${base}/manual-payments/requests/${id}/mark-paid`, { method: 'POST', headers: auth(owner) });
  assert.equal(report.status, 200);
  const res = await fetch(`${base}/manual-payments/requests/${id}`, { headers: auth(owner) });
  const data = await res.json();
  assert.equal(data.request.status, 'PAID_REPORTED');
  assert.equal(data.access.isPremium, false);
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal((await fetch(`${base}/admin/manual-payments/${id}/approve`, { method: 'POST', headers: auth(owner) })).status, 403);
});

test('different payments extend the account serially and duplicate approval grants once', async () => {
  const baseDate = new Date('2030-01-01T00:00:00Z');
  await prisma.userAccount.update({ where: { id: owner.id }, data: { premiumValidUntil: baseDate } });
  const ids = await Promise.all([payment(), payment()]);
  for (const id of ids) assert.equal((await reportPayment(id)).status, 200);
  const approvals = await Promise.all([approve(ids[0]), approve(ids[1]), approve(ids[0])]);
  for (const result of approvals) assert.equal(result.status, 200, await result.text());
  const updated = await prisma.userAccount.findUnique({ where: { id: owner.id } });
  assert.equal(updated.premiumValidUntil.getTime(), baseDate.getTime() + 60 * 86400000);
  assert.equal(updated.premiumSource, 'manual');
  const data = await (await fetch(`${base}/manual-payments/requests/${ids[0]}`, { headers: auth(owner) })).json();
  assert.equal(data.request.status, 'APPROVED');
  assert.equal(data.access.isPremium, true);
});

test('monthly approval preserves an existing lifetime entitlement', async () => {
  await prisma.userAccount.update({ where: { id: owner.id }, data: { premiumValidUntil: new Date('9999-12-31T23:59:59Z') } });
  const id = await payment();
  assert.equal((await reportPayment(id)).status, 200);
  assert.equal((await approve(id)).status, 200);
  const updated = await prisma.userAccount.findUnique({ where: { id: owner.id } });
  assert.equal(updated.premiumValidUntil.toISOString(), '9999-12-31T23:59:59.000Z');
});

test('vocabulary pages are bounded, complete across offsets, and still mask Premium data', async () => {
  const book = `premium-test-${runId}`;
  await prisma.vocabulary.createMany({ data: Array.from({ length: 501 }, (_, index) => ({
    word_ja: `test-${index}`, word_vi: 'protected meaning', track: 'book', source_book: book, source_unit: '1',
  })) });
  const course = `/vocabulary/all?track=book&sourceBook=${book}`;
  const defaults = await (await fetch(`${base}${course}`)).json();
  assert.equal(defaults.length, 250);
  assert.equal(defaults[0].isLocked, true);
  assert.equal(defaults[0].word_vi, null);
  const first = await (await fetch(`${base}${course}&limit=500`, { headers: auth(owner) })).json();
  const second = await (await fetch(`${base}${course}&limit=500&offset=500`, { headers: auth(owner) })).json();
  assert.equal(first.length, 500);
  assert.equal(second.length, 1);
  assert.equal(new Set([...first, ...second].map((word) => word.id)).size, 501);
  assert.equal(first[0].word_vi, 'protected meaning');
  assert.equal((await fetch(`${base}${course}&offset=-1`)).status, 400);
});

test('catalog, payment record and VietQR use the same price; stale quotes are rejected', async () => {
  await prisma.$executeRaw`INSERT INTO manual_payment_setting
    (provider, monthly_amount, yearly_amount, lifetime_amount, currency, account_no, bank_id, enabled)
    VALUES ('MSB', 99000, 365000, 1699000, 'VND', '000000000', 'MSB', TRUE)
    ON CONFLICT (provider) DO UPDATE SET monthly_amount = 99000, yearly_amount = 365000, lifetime_amount = 1699000,
      currency = 'VND', account_no = '000000000', bank_id = 'MSB', enabled = TRUE`;
  const settings = await (await fetch(`${base}/manual-payments/settings`)).json();
  const headers = { ...auth(owner), 'Content-Type': 'application/json' };
  const create = (expectedAmount) => fetch(`${base}/manual-payments/requests`, { method: 'POST', headers,
    body: JSON.stringify({ provider: 'MSB', billingPeriod: 'monthly', expectedAmount, expectedCurrency: 'VND' }) });
  const good = await create(settings.MSB.monthlyAmount);
  assert.equal(good.status, 200);
  const { request } = await good.json();
  assert.equal(request.amount, 99000);
  assert.equal(new URL(request.qrImageUrl).searchParams.get('amount'), '99000');
  assert.equal((await create(999000)).status, 409);
  const listed = await (await fetch(`${base}/admin/manual-payments?requestId=${request.id}`, { headers: auth(admin) })).json();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, request.id);
});

test('payment report atomically creates one admin bell alert and remains visible in the admin list', async () => {
  const id = await payment();
  const report = () => fetch(`${base}/manual-payments/requests/${id}/mark-paid`, { method: 'POST', headers: auth(owner) });
  for (const response of await Promise.all([report(), report(), report()])) assert.equal(response.status, 200);
  const link = `/admin/manual-payments?openRequestId=${id}`;
  const alerts = await prisma.$queryRaw`SELECT * FROM user_mailbox WHERE user_id = ${admin.id} AND link = ${link}`;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].is_read, false);
  const bell = await (await fetch(`${base}/mailbox/mine`, { headers: auth(admin) })).json();
  assert.ok(bell.unreadCount > 0);
  assert.ok(bell.items.some((mail) => mail.link === link));
  const listed = await (await fetch(`${base}/admin/manual-payments?status=PAID_REPORTED`, { headers: auth(admin) })).json();
  assert.ok(listed.items.some((item) => String(item.id) === id));
  assert.equal(listed.items[0].status, 'PAID_REPORTED');
  // Query parameters cannot impersonate the admin and read payment alerts.
  const otherBell = await (await fetch(`${base}/mailbox/mine?userId=${admin.id}`, { headers: auth(stranger) })).json();
  assert.equal(otherBell.items.some((mail) => mail.link === link), false);
  assert.equal((await fetch(`${base}/mailbox/mine?userId=${admin.id}`)).status, 401);
});

test('creating an MSB or PayPay checkout cannot notify reviewers or be approved before the user reports payment', async () => {
  for (const provider of ['MSB', 'PAYPAY']) {
    const response = await fetch(`${base}/manual-payments/requests`, {
      method: 'POST', headers: { ...auth(owner), 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, billingPeriod: 'monthly' }),
    });
    assert.equal(response.status, 200);
    const { request } = await response.json();
    assert.equal(request.status, 'PENDING');
    const list = async (query = '') => (await (await fetch(`${base}/admin/manual-payments${query}`, { headers: auth(admin) })).json()).items;
    assert.equal((await list()).some((item) => item.id === request.id), false);
    assert.equal((await list('?status=')).some((item) => item.id === request.id), false);
    assert.equal((await list('?status=PENDING')).some((item) => item.id === request.id), false);
    assert.ok((await list(`?requestId=${request.id}`)).some((item) => item.id === request.id));
    const link = `/admin/manual-payments?openRequestId=${request.id}`;
    const alerts = await prisma.$queryRaw`SELECT id FROM user_mailbox WHERE link = ${link}`;
    assert.equal(alerts.length, 0);
    const before = await prisma.userAccount.findUnique({ where: { id: owner.id } });
    assert.equal((await approve(request.id)).status, 409);
    const after = await prisma.userAccount.findUnique({ where: { id: owner.id } });
    assert.equal(after.premiumValidUntil?.getTime(), before.premiumValidUntil?.getTime());
    assert.equal((await reportPayment(request.id)).status, 200);
    assert.ok((await list()).some((item) => item.id === request.id));
    assert.equal((await approve(request.id)).status, 200);
    assert.equal((await approve(request.id)).status, 200);
  }
});
