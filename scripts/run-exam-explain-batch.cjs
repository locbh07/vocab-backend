// Batch-generate AI explanations for JLPT exam questions, by driving the admin endpoint
// POST /exam/admin/explain-batch until it reports completed. Already-cached questions are
// skipped unless --force is passed.
//
// Usage:
//   node scripts/run-exam-explain-batch.cjs --level=N2 --examId=201007 --part=1
//   node scripts/run-exam-explain-batch.cjs --level=N2 --examId=201007 --parts=1,2,3
//   node scripts/run-exam-explain-batch.cjs --level=N2                          # whole level, all exams, all parts
//   node scripts/run-exam-explain-batch.cjs --level=N2 --force
//
// Env vars:
//   API_BASE_URL   default http://localhost:4000
//   ADMIN_USERNAME admin account username (must have role ADMIN)
//   ADMIN_USER_ID  admin account id (alternative/complement to ADMIN_USERNAME)
//   CHUNK_LIMIT    units per request, default 5 (max 20 enforced server-side)
//   DELAY_MS       delay between chunk requests, default 500

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '';
const CHUNK_LIMIT = Math.min(20, Math.max(1, Number(process.env.CHUNK_LIMIT || 5)));
const DELAY_MS = Math.max(0, Number(process.env.DELAY_MS || 500));

function parseArgs() {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    const match = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    args[match[1]] = match[2] === undefined ? true : match[2];
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listExamIdsForLevel(level) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.jlptExam.findMany({
      where: { level },
      select: { exam_id: true },
      distinct: ['exam_id'],
      orderBy: { exam_id: 'asc' },
    });
    return rows.map((r) => r.exam_id);
  } finally {
    await prisma.$disconnect();
  }
}

async function runOnePart(level, examId, part, forceRefresh) {
  console.log(`\n=== ${level} ${examId} part ${part} ===`);

  let startIndex = 0;
  let totalGenerated = 0;
  let totalSkipped = 0;
  const allFailed = [];

  for (;;) {
    const res = await fetch(`${API_BASE_URL}/exam/admin/explain-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ADMIN_USERNAME ? { 'X-Admin-Username': ADMIN_USERNAME } : {}),
        ...(ADMIN_USER_ID ? { 'X-Admin-UserId': ADMIN_USER_ID } : {}),
      },
      body: JSON.stringify({ level, examId, part, startIndex, limit: CHUNK_LIMIT, forceRefresh }),
    });
    const json = await res.json();
    if (!res.ok) {
      if (res.status === 404) {
        console.log('  (part not found, skipping)');
        return;
      }
      throw new Error(`explain-batch failed (${res.status}): ${JSON.stringify(json)}`);
    }

    totalGenerated += json.generated || 0;
    totalSkipped += json.skippedCached || 0;
    if (Array.isArray(json.failed) && json.failed.length) allFailed.push(...json.failed);

    console.log(
      `  [${json.nextIndex}/${json.total}] generated=${json.generated} skippedCached=${json.skippedCached} failed=${json.failed?.length || 0}`,
    );

    if (json.completed) break;
    startIndex = json.nextIndex;
    if (DELAY_MS) await sleep(DELAY_MS);
  }

  console.log(`  -> done. generated=${totalGenerated} skippedCached=${totalSkipped} failed=${allFailed.length}`);
  if (allFailed.length) {
    console.log('  failed units:', JSON.stringify(allFailed, null, 2));
  }
  return { generated: totalGenerated, skippedCached: totalSkipped, failed: allFailed.length };
}

async function main() {
  const args = parseArgs();
  const level = args.level;
  const forceRefresh = Boolean(args.force);

  if (!level) {
    console.error(
      'Usage: node scripts/run-exam-explain-batch.cjs --level=N2 [--examId=201007] [--part=1 | --parts=1,2,3] [--force]',
    );
    process.exit(1);
  }
  if (!ADMIN_USERNAME && !ADMIN_USER_ID) {
    console.error('Set ADMIN_USERNAME or ADMIN_USER_ID env var (an account with role ADMIN)');
    process.exit(1);
  }

  const parts = args.parts
    ? String(args.parts)
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => [1, 2, 3].includes(v))
    : args.part
      ? [Number(args.part)]
      : [1, 2, 3];

  const examIds = args.examId ? [String(args.examId)] : await listExamIdsForLevel(level);
  if (!examIds.length) {
    console.error(`No exams found for level ${level}`);
    process.exit(1);
  }
  console.log(`Running explain-batch for ${level}: ${examIds.length} exam(s) x parts [${parts.join(',')}]`);
  console.log(examIds.join(', '));

  const totals = { generated: 0, skippedCached: 0, failed: 0 };
  for (const examId of examIds) {
    for (const part of parts) {
      const result = await runOnePart(level, examId, part, forceRefresh);
      if (result) {
        totals.generated += result.generated;
        totals.skippedCached += result.skippedCached;
        totals.failed += result.failed;
      }
    }
  }

  console.log(
    `\n=== ALL DONE (${level}) === generated=${totals.generated} skippedCached=${totals.skippedCached} failed=${totals.failed}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
