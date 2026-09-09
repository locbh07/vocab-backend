// No database or AI requests: exercise the router's provider/model authorization contract.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');
require('express-async-errors');
const express = require('express');
const userGuard = require('../src/middleware/userGuard');
const gemini = require('../src/lib/geminiLive');
const openai = require('../src/lib/openaiRealtime');
let user = { id: 1, role: 'USER', speakingLiveEnabled: true };
let selected;
userGuard.requireUser = async () => user;
gemini.mintGeminiLiveToken = async args => {
  selected = args;
  return { value: 'test-ephemeral-token', expiresAt: 1, model: args.model || 'test-default', voice: args.voice };
};
openai.mintRealtimeClientSecret = async () => { throw new Error('Unexpected OpenAI request'); };
const { createSpeakingLiveRouter } = require('../src/routes/speakingLive');
const app = express();
app.use(express.json());
app.use(createSpeakingLiveRouter());
app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
const server = app.listen(0, '127.0.0.1');
after(() => new Promise(resolve => server.close(resolve)));
async function post(body) {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  return fetch(`http://127.0.0.1:${server.address().port}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
test('ordinary live-enabled learners receive default model even when replaying an allowed override', async () => {
  const response = await post({ provider: 'gemini', model: gemini.ALLOWED_GEMINI_LIVE_MODELS[1] });
  assert.equal(response.status, 200);
  assert.equal(selected.model, undefined);
  assert.equal((await response.json()).model, 'test-default');
});
test('ordinary learners cannot switch providers through request body', async () => {
  const response = await post({ provider: 'openai', model: 'gpt-realtime' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).provider, 'gemini');
});
test('admins can select an allowed Gemini model', async () => {
  user = { ...user, role: 'ADMIN' };
  const response = await post({ model: gemini.ALLOWED_GEMINI_LIVE_MODELS[1], teacher: 'linh', mode: 'conversation' });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.model, gemini.ALLOWED_GEMINI_LIVE_MODELS[1]);
  assert.equal(body.teacherName, 'Cô Linh');
  assert.equal(body.mode, 'conversation');
});
test('unknown model values fall back to default', async () => {
  const response = await post({ model: 'not-an-allowed-model' });
  assert.equal(response.status, 200);
  assert.equal(selected.model, undefined);
});
test('a learner without live access cannot mint a token', async () => {
  user = { ...user, role: 'USER', speakingLiveEnabled: false };
  const response = await post({});
  assert.equal(response.status, 403);
});
