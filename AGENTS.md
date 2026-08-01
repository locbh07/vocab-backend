# Agent Instructions

## Project Shape

This is a Node.js backend for vocabulary/JLPT content built with Express, TypeScript, Prisma, and Supabase.

Important paths:
- `src/main.ts`: local server entrypoint.
- `src/app.ts`: Express app setup.
- `src/routes/`: API route modules.
- `src/lib/`: shared backend helpers.
- `prisma/schema.prisma`: Prisma schema.
- `prisma/migrations/`: database migrations.
- `scripts/`: data import, sync, and maintenance scripts.
- `docs/`: API contracts and project notes.

## Common Commands

Use these commands from the repository root:

```bash
npm install
npm run build
npm run dev
```

Environment helpers:

```bash
npm run env:local
npm run env:staging
npm run env:production
```

Database commands:

```bash
npm run prisma -- generate
npm run prisma:migrate:dev:local
npm run prisma:migrate:deploy:staging
npm run prisma:migrate:deploy:production
```

## Environment Rules

- Do not print or expose secrets from `.env`, `.env.local`, `.env.staging`, or `.env.production`.
- Prefer `.env.local` for local development.
- Do not change production/staging environment files unless explicitly asked.
- Before running scripts that mutate data, inspect the script and confirm which environment it uses.

## Development Rules

- Keep route behavior compatible with existing frontend/API clients unless the task explicitly changes the contract.
- Prefer existing helpers in `src/lib/` and existing middleware in `src/middleware/`.
- Keep Prisma migrations explicit and reviewable.
- Run `npm run build` before handing off code changes when practical.
- Do not rewrite generated or exported data files unless the task is about those files.

## Orca + Codex Workflow

When this repo is opened in Orca, use Codex as a CLI agent in a dedicated worktree.

Recommended flow:
1. Create a new Orca worktree from the current base branch.
2. Pick `Codex` from the agent selector.
3. Ask Codex to inspect the relevant files before editing.
4. After edits, run `npm run build`.
5. Review the Orca diff before committing or merging the worktree.

Good prompts for this repo:

```text
Inspect the Express route and Prisma schema related to <feature>. Propose the smallest safe change, then implement it and run npm run build.
```

```text
Review the current diff for backend regressions, API contract changes, Prisma migration risk, and missing build/test coverage.
```

```text
Add a new backend endpoint for <feature>. Follow existing route and middleware patterns. Update docs if the API contract changes.
```
