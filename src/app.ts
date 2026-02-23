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
import { jsonSafe } from './lib/jsonSafe';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => originalJson(jsonSafe(body));
  next();
});

app.use('/auth', createAuthRouter());
app.use('/api/auth', createAuthRouter());
app.use('/vocabulary', createVocabularyRouter());
app.use('/api/vocabulary', createVocabularyRouter());
app.use('/grammar', createGrammarRouter());
app.use('/api/grammar', createGrammarRouter());
app.use('/learning', createLearningRouter());
app.use('/api/learning', createLearningRouter());
app.use('/exam', createExamRouter());
app.use('/api/exam', createExamRouter());
app.use('/admin/users', createAdminUsersRouter());
app.use('/api/admin/users', createAdminUsersRouter());
app.use('/admin/vocabulary', createAdminVocabularyRouter());
app.use('/api/admin/vocabulary', createAdminVocabularyRouter());
app.use('/admin/exam', createAdminExamRouter());
app.use('/api/admin/exam', createAdminExamRouter());

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (err as { status?: number })?.status || 500;
  const message = (err as { message?: string })?.message || 'Internal server error';
  res.status(status).json({ success: false, message });
});

export default app;
