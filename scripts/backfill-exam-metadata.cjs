#!/usr/bin/env node

const path = require('path');

const root = path.resolve(__dirname, '..');
const { upsertExamQuestionMetaForAll, upsertExamQuestionMetaForExam, upsertExamQuestionMetaForLevel } = require(path.join(
  root,
  'dist',
  'lib',
  'examQuestionMeta.js',
));
const { prisma } = require(path.join(root, 'dist', 'lib', 'prisma.js'));

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function forceEnabled() {
  const fromFlag = hasFlag('force');
  const fromArg = readArg('force');
  if (fromFlag) return true;
  if (fromArg) {
    const v = String(fromArg).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  }
  const envForce = String(process.env.npm_config_force || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(envForce);
}

async function main() {
  const level = readArg('level');
  const examId = readArg('exam');
  const levels = readArg('levels')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const force = forceEnabled();

  if (level && examId) {
    const summary = await upsertExamQuestionMetaForExam({ level, examId, force });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (level) {
    const summary = await upsertExamQuestionMetaForLevel({ level, force });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (levels.length) {
    const summary = await upsertExamQuestionMetaForAll({ levels, force });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const summary = await upsertExamQuestionMetaForAll({ force });
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
