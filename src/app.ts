import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import dotenv from 'dotenv';
import { createAuthRouter } from './routes/auth';
import { createVocabularyRouter } from './routes/vocabulary';
import { createGrammarRouter } from './routes/grammar';
import { createLearningRouter } from './routes/learning';
import { createExamRouter } from './routes/exam';
import { createAdminUsersRouter } from './routes/adminUsers';
import { createAdminVocabularyRouter } from './routes/adminVocabulary';
import { createAdminExamRouter } from './routes/adminExam';
import { createUserPreferencesRouter } from './routes/userPreferences';
import { createKanjiRouter } from './routes/kanji';
import { createListeningRouter } from './routes/listening';
import { createFeedbackRouter } from './routes/feedback';
import { createAdminFeedbackRouter } from './routes/adminFeedback';
import { createAdminListeningRouter } from './routes/adminListening';
import { createLearningGameRouter } from './routes/learningGame';
import { createMailboxRouter } from './routes/mailbox';
import { createAdminMailboxRouter } from './routes/adminMailbox';
import { createCommentsRouter } from './routes/comments';
import { createAdminCommentsRouter } from './routes/adminComments';
import { createContactRouter } from './routes/contact';
import { createAdminContactRouter } from './routes/adminContact';
import { createBillingRouter, createStripeWebhookRouter } from './routes/billing';
import { createAdminManualPaymentRouter, createManualPaymentRouter } from './routes/manualPayments';
import { createAdminAiReviewRouter } from './routes/adminAiReview';
import { jsonSafe } from './lib/jsonSafe';
import { createSimpleRateLimit } from './middleware/simpleRateLimit';
import { createApiShield } from './middleware/apiShield';
import { contentGuard } from './middleware/contentGuard';

dotenv.config();

const app = express();
const apiShieldEnabled = String(process.env.API_SHIELD_ENABLED || 'true').toLowerCase() !== 'false';
const apiShieldWindowMs = Number(process.env.API_SHIELD_WINDOW_MS || 60_000);
const apiShieldDistinctWindowMs = Number(process.env.API_SHIELD_DISTINCT_WINDOW_MS || 300_000);
const apiShieldBlockMs = Number(process.env.API_SHIELD_BLOCK_MS || 600_000);
const apiShieldSuspiciousScoreWindowMs = Number(process.env.API_SHIELD_SUSPICIOUS_SCORE_WINDOW_MS || 300_000);
const apiShieldSuspiciousScoreThreshold = Number(process.env.API_SHIELD_SUSPICIOUS_SCORE_THRESHOLD || 14);
const apiShieldMaxDistinctTargetsPerIp = Number(process.env.API_SHIELD_MAX_DISTINCT_TARGETS_PER_IP || 80);
const apiShieldRapidRequestIntervalMs = Number(process.env.API_SHIELD_RAPID_REQUEST_INTERVAL_MS || 250);
const apiShieldRapidRequestBurst = Number(process.env.API_SHIELD_RAPID_REQUEST_BURST || 18);
const apiShieldMaxSequentialNumericTargets = Number(process.env.API_SHIELD_MAX_SEQUENTIAL_NUMERIC_TARGETS || 12);

const createRouteShield = (keyPrefix: string, maxRequestsPerIp: number, maxRequestsPerUser: number) =>
  createApiShield({
    windowMs: apiShieldWindowMs,
    distinctWindowMs: apiShieldDistinctWindowMs,
    blockMs: apiShieldBlockMs,
    maxDistinctUsersPerIp: Number(process.env.API_SHIELD_MAX_DISTINCT_USERS_PER_IP || 6),
    maxRequestsPerIp: Number(process.env.API_SHIELD_MAX_REQUESTS_PER_IP || maxRequestsPerIp),
    maxRequestsPerUser: Number(process.env.API_SHIELD_MAX_REQUESTS_PER_USER || maxRequestsPerUser),
    suspiciousScoreWindowMs: apiShieldSuspiciousScoreWindowMs,
    suspiciousScoreThreshold: apiShieldSuspiciousScoreThreshold,
    maxDistinctTargetsPerIp: apiShieldMaxDistinctTargetsPerIp,
    rapidRequestIntervalMs: apiShieldRapidRequestIntervalMs,
    rapidRequestBurst: apiShieldRapidRequestBurst,
    maxSequentialNumericTargets: apiShieldMaxSequentialNumericTargets,
    keyPrefix,
  });
const configuredCorsOrigin = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const builtInCorsOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://jp-vocab-frontend.vercel.app',
]);

function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

if (configuredCorsOrigin.length === 0) {
  app.use(cors());
} else {
  app.use(
    cors({
      origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void,
      ) => {
        // Allow same-origin/server-to-server requests without Origin header.
        if (
          !origin ||
          configuredCorsOrigin.includes(origin) ||
          builtInCorsOrigins.has(origin) ||
          isLocalhostOrigin(origin)
        ) {
          callback(null, true);
          return;
        }
        callback(new Error('Not allowed by CORS'));
      },
    }),
  );
}
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), createStripeWebhookRouter());
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), createStripeWebhookRouter());
app.use(express.json({ limit: '6mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => originalJson(jsonSafe(body));
  next();
});

app.use('/auth', createAuthRouter());
app.use('/api/auth', createAuthRouter());
app.use('/billing', createBillingRouter());
app.use('/api/billing', createBillingRouter());
app.use('/manual-payments', createManualPaymentRouter());
app.use('/api/manual-payments', createManualPaymentRouter());
app.use(
  '/vocabulary',
  ...(apiShieldEnabled ? [createRouteShield('vocabulary-shield', 180, 140)] : []),
  contentGuard,
  createSimpleRateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'vocabulary' }),
  createVocabularyRouter(),
);
app.use(
  '/api/vocabulary',
  ...(apiShieldEnabled ? [createRouteShield('api-vocabulary-shield', 180, 140)] : []),
  contentGuard,
  createSimpleRateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'api-vocabulary' }),
  createVocabularyRouter(),
);
app.use(
  '/grammar',
  ...(apiShieldEnabled ? [createRouteShield('grammar-shield', 160, 120)] : []),
  contentGuard,
  createSimpleRateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'grammar' }),
  createGrammarRouter(),
);
app.use(
  '/api/grammar',
  ...(apiShieldEnabled ? [createRouteShield('api-grammar-shield', 160, 120)] : []),
  contentGuard,
  createSimpleRateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'api-grammar' }),
  createGrammarRouter(),
);
app.use(
  '/learning',
  ...(apiShieldEnabled ? [createRouteShield('learning-shield', 160, 120)] : []),
  createLearningRouter(),
);
app.use(
  '/api/learning',
  ...(apiShieldEnabled ? [createRouteShield('api-learning-shield', 160, 120)] : []),
  createLearningRouter(),
);
app.use(
  '/learning/game',
  ...(apiShieldEnabled ? [createRouteShield('learning-game-shield', 140, 100)] : []),
  createSimpleRateLimit({ windowMs: 60_000, max: 100, keyPrefix: 'learning-game' }),
  createLearningGameRouter(),
);
app.use(
  '/api/learning/game',
  ...(apiShieldEnabled ? [createRouteShield('api-learning-game-shield', 140, 100)] : []),
  createSimpleRateLimit({ windowMs: 60_000, max: 100, keyPrefix: 'api-learning-game' }),
  createLearningGameRouter(),
);
app.use(
  '/exam',
  ...(apiShieldEnabled ? [createRouteShield('exam-shield', 100, 80)] : []),
  createSimpleRateLimit({ windowMs: 60_000, max: 90, keyPrefix: 'exam' }),
  createExamRouter(),
);
app.use(
  '/api/exam',
  ...(apiShieldEnabled ? [createRouteShield('api-exam-shield', 100, 80)] : []),
  createSimpleRateLimit({ windowMs: 60_000, max: 90, keyPrefix: 'api-exam' }),
  createExamRouter(),
);
app.use('/admin/users', createAdminUsersRouter());
app.use('/api/admin/users', createAdminUsersRouter());
app.use('/admin/vocabulary', createAdminVocabularyRouter());
app.use('/api/admin/vocabulary', createAdminVocabularyRouter());
app.use('/admin/exam', createAdminExamRouter());
app.use('/api/admin/exam', createAdminExamRouter());
app.use('/user/preferences', createUserPreferencesRouter());
app.use('/api/user/preferences', createUserPreferencesRouter());
app.use(
  '/kanji',
  ...(apiShieldEnabled ? [createRouteShield('kanji-shield', 160, 120)] : []),
  createSimpleRateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'kanji' }),
  createKanjiRouter(),
);
app.use(
  '/api/kanji',
  ...(apiShieldEnabled ? [createRouteShield('api-kanji-shield', 160, 120)] : []),
  createSimpleRateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'api-kanji' }),
  createKanjiRouter(),
);
app.use(
  '/listening',
  ...(apiShieldEnabled ? [createRouteShield('listening-shield', 120, 90)] : []),
  contentGuard,
  createSimpleRateLimit({ windowMs: 60_000, max: 90, keyPrefix: 'listening' }),
  createListeningRouter(),
);
app.use(
  '/api/listening',
  ...(apiShieldEnabled ? [createRouteShield('api-listening-shield', 120, 90)] : []),
  contentGuard,
  createSimpleRateLimit({ windowMs: 60_000, max: 90, keyPrefix: 'api-listening' }),
  createListeningRouter(),
);
app.use('/feedback', createSimpleRateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'feedback' }), createFeedbackRouter());
app.use('/api/feedback', createSimpleRateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'api-feedback' }), createFeedbackRouter());
app.use('/admin/feedback', createAdminFeedbackRouter());
app.use('/api/admin/feedback', createAdminFeedbackRouter());
app.use('/comments', createSimpleRateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'comments' }), createCommentsRouter());
app.use('/api/comments', createSimpleRateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'api-comments' }), createCommentsRouter());
app.use('/admin/comments', createAdminCommentsRouter());
app.use('/api/admin/comments', createAdminCommentsRouter());
app.use('/contact', createSimpleRateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'contact' }), createContactRouter());
app.use('/api/contact', createSimpleRateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'api-contact' }), createContactRouter());
app.use('/admin/contact', createAdminContactRouter());
app.use('/api/admin/contact', createAdminContactRouter());
app.use('/admin/manual-payments', createAdminManualPaymentRouter());
app.use('/api/admin/manual-payments', createAdminManualPaymentRouter());
app.use('/admin/listening', createAdminListeningRouter());
app.use('/api/admin/listening', createAdminListeningRouter());
app.use('/admin/ai-review', createAdminAiReviewRouter());
app.use('/api/admin/ai-review', createAdminAiReviewRouter());
app.use('/mailbox', createSimpleRateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'mailbox' }), createMailboxRouter());
app.use('/api/mailbox', createSimpleRateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'api-mailbox' }), createMailboxRouter());
app.use('/admin/mailbox', createAdminMailboxRouter());
app.use('/api/admin/mailbox', createAdminMailboxRouter());

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (err as { status?: number })?.status || 500;
  const message = (err as { message?: string })?.message || 'Internal server error';
  res.status(status).json({ success: false, message });
});

export default app;
