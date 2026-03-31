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
import { jsonSafe } from './lib/jsonSafe';
import { createSimpleRateLimit } from './middleware/simpleRateLimit';
import { createApiShield } from './middleware/apiShield';

dotenv.config();

const app = express();
const apiShieldEnabled = String(process.env.API_SHIELD_ENABLED || 'true').toLowerCase() !== 'false';
const apiShieldWindowMs = Number(process.env.API_SHIELD_WINDOW_MS || 60_000);
const apiShieldDistinctWindowMs = Number(process.env.API_SHIELD_DISTINCT_WINDOW_MS || 300_000);
const apiShieldBlockMs = Number(process.env.API_SHIELD_BLOCK_MS || 600_000);

const createRouteShield = (keyPrefix: string, maxRequestsPerIp: number, maxRequestsPerUser: number) =>
  createApiShield({
    windowMs: apiShieldWindowMs,
    distinctWindowMs: apiShieldDistinctWindowMs,
    blockMs: apiShieldBlockMs,
    maxDistinctUsersPerIp: Number(process.env.API_SHIELD_MAX_DISTINCT_USERS_PER_IP || 6),
    maxRequestsPerIp: Number(process.env.API_SHIELD_MAX_REQUESTS_PER_IP || maxRequestsPerIp),
    maxRequestsPerUser: Number(process.env.API_SHIELD_MAX_REQUESTS_PER_USER || maxRequestsPerUser),
    keyPrefix,
  });
const configuredCorsOrigin = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const localhostCorsOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

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
          localhostCorsOrigins.has(origin) ||
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
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => originalJson(jsonSafe(body));
  next();
});

app.use('/auth', createAuthRouter());
app.use('/api/auth', createAuthRouter());
app.use(
  '/vocabulary',
  ...(apiShieldEnabled ? [createRouteShield('vocabulary-shield', 180, 140)] : []),
  createSimpleRateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'vocabulary' }),
  createVocabularyRouter(),
);
app.use(
  '/api/vocabulary',
  ...(apiShieldEnabled ? [createRouteShield('api-vocabulary-shield', 180, 140)] : []),
  createSimpleRateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'api-vocabulary' }),
  createVocabularyRouter(),
);
app.use('/grammar', createSimpleRateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'grammar' }), createGrammarRouter());
app.use('/api/grammar', createSimpleRateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'api-grammar' }), createGrammarRouter());
app.use('/learning', createLearningRouter());
app.use('/api/learning', createLearningRouter());
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
app.use('/kanji', createKanjiRouter());
app.use('/api/kanji', createKanjiRouter());
app.use(
  '/listening',
  ...(apiShieldEnabled ? [createRouteShield('listening-shield', 120, 90)] : []),
  createSimpleRateLimit({ windowMs: 60_000, max: 90, keyPrefix: 'listening' }),
  createListeningRouter(),
);
app.use(
  '/api/listening',
  ...(apiShieldEnabled ? [createRouteShield('api-listening-shield', 120, 90)] : []),
  createSimpleRateLimit({ windowMs: 60_000, max: 90, keyPrefix: 'api-listening' }),
  createListeningRouter(),
);
app.use('/feedback', createSimpleRateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'feedback' }), createFeedbackRouter());
app.use('/api/feedback', createSimpleRateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'api-feedback' }), createFeedbackRouter());
app.use('/admin/feedback', createAdminFeedbackRouter());
app.use('/api/admin/feedback', createAdminFeedbackRouter());
app.use('/admin/listening', createAdminListeningRouter());
app.use('/api/admin/listening', createAdminListeningRouter());

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (err as { status?: number })?.status || 500;
  const message = (err as { message?: string })?.message || 'Internal server error';
  res.status(status).json({ success: false, message });
});

export default app;
