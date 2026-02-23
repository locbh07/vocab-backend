# Vocab Backend (Express + TypeScript + Prisma + Supabase)

Quick scaffold to start migrating the Java backend to Node.js.

Getting started

1. Copy `.env.example` to `.env` and fill values.

2. Install deps:

```bash
npm install
```

3. Initialize Prisma (after setting `DATABASE_URL` to your Postgres/Supabase DB):

```bash
npx prisma generate
npx prisma db push # or prisma migrate
node prisma/seed.ts
```

4. Run dev server:

```bash
npm run dev
```

Next steps:

- Use `prisma db pull` against your Supabase/Postgres to generate actual models from `jlpt_schema.sql`.
- Implement feature modules mirroring Spring controllers and MyBatis mappers.
- Integrate Supabase Auth for authentication.

## Deploy Backend to Vercel

This repo is configured to run Express on Vercel via `api/index.ts`.

1. Import this repository as a separate Vercel project (Backend project).
2. Set Environment Variable `DATABASE_URL` on Vercel (Supabase URL with SSL).
3. Deploy.
4. Run migrations to production DB:

```bash
npm run prisma:migrate:deploy:production
```

Recommended Supabase connection string format:

```bash
postgresql://postgres:password@db.xxxxx.supabase.co:5432/postgres?sslmode=require
```
