const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
process.env.NODE_ENV = 'test';
process.env.API_RATE_LIMIT_STORE = 'memory';
process.env.JWT_SECRET = 'synthetic-free-content-test';
process.env.DATABASE_URL = 'postgresql://unused@127.0.0.1:1/unused';
const { encodeContent, contentEnvelope } = require('../dist/middleware/contentEnvelope');
const { resolveContentAccess } = require('../dist/lib/contentAccess');
const { createBillingRouter } = require('../dist/routes/billing');
const { createManualPaymentRouter } = require('../dist/routes/manualPayments');
const express = require('express');

test('anonymous learning is free without a database or paid identity', async () => {
  assert.deepEqual(await resolveContentAccess({ header: () => undefined }), { isPremium: true, userId: null });
});

test('API packets decode in the frontend, use fresh IVs and reject tampering', async () => {
  const { decodeContent } = await import(pathToFileURL(path.resolve(__dirname, '../../vocab-frontend/src/utils/contentCodec.js')).href);
  const body = { text: '日本語', items: [1, 2], id: '42' };
  const packet = encodeContent(body);
  assert.notEqual(packet.iv, encodeContent(body).iv);
  assert.deepEqual(await decodeContent(packet), body);
  const corrupted = Buffer.from(packet.payload, 'base64');
  corrupted[0] ^= 1;
  await assert.rejects(decodeContent({ ...packet, payload: corrupted.toString('base64') }));
  assert.deepEqual(await decodeContent(body), body);
});

test('HTTP negotiation, error compatibility and retired purchases', async (t) => {
  const app = express();
  app.use(contentEnvelope);
  app.get(['/vocabulary', '/api/vocabulary'], (_req, res) => res.json({ items: ['日本語'] }));
  app.get('/grammar', (_req, res) => res.status(429).json({ message: 'Slow down' }));
  app.use('/billing', createBillingRouter());
  app.use('/manual-payments', createManualPaymentRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'X-Content-Codec': 'daisuki-content-v1' };
  for (const route of ['/vocabulary', '/api/vocabulary']) {
    const response = await fetch(base + route, { headers });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(response.headers.get('vary'), /X-Content-Codec/);
    assert.equal((await response.json()).codec, 'daisuki-content-v1');
    assert.deepEqual(await (await fetch(base + route)).json(), { items: ['日本語'] });
  }
  assert.deepEqual(await (await fetch(base + '/grammar', { headers })).json(), { message: 'Slow down' });
  for (const route of ['/billing/trial/activate', '/billing/checkout-session', '/manual-payments/requests']) {
    const response = await fetch(base + route, { method: 'POST' });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, 'PREMIUM_RETIRED');
  }
});
