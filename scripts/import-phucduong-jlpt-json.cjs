const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function parseArgs() {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    if (index >= 0) return args[index + 1];
    return args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  };
  return {
    apply: args.includes('--apply'),
    envName: valueAfter('--env') || 'local',
    inputDir: path.resolve(
      process.cwd(),
      valueAfter('--input') || path.join('downloads', 'phucduong-jlpt-json-2026-06-23'),
    ),
  };
}

const options = parseArgs();
const envFile = path.resolve(process.cwd(), options.envName === 'local' ? '.env.local' : `.env.${options.envName}`);
if (!fs.existsSync(envFile)) throw new Error(`Environment file not found: ${envFile}`);
dotenv.config({ path: envFile, override: true });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const VALID_LEVELS = ['N1', 'N2', 'N3', 'N4', 'N5'];

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, 'utf8');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function contentWithoutEmbeddedExplanation(data) {
  const clone = JSON.parse(JSON.stringify(data));
  for (const section of clone.sections || []) {
    for (const question of section.questions || []) delete question.expl;
  }
  return clone;
}

function loadInputFiles(inputDir) {
  const items = [];
  const skipped = [];
  for (const level of VALID_LEVELS) {
    const levelDir = path.join(inputDir, level);
    if (!fs.existsSync(levelDir)) throw new Error(`Missing level folder: ${levelDir}`);
    for (const filename of fs.readdirSync(levelDir).filter((name) => name.toLowerCase().endsWith('.json'))) {
      const match = filename.match(/^(N[1-5])-(\d{4})-(\d{1,2})-([1-3])\.json$/i);
      if (!match) {
        skipped.push(`${level}/${filename}`);
        continue;
      }
      const fileLevel = match[1].toUpperCase();
      const month = Number(match[3]);
      if (fileLevel !== level || ![7, 12].includes(month)) {
        skipped.push(`${level}/${filename}`);
        continue;
      }
      const part = Number(match[4]);
      const examId = `${match[2]}${String(month).padStart(2, '0')}`;
      const json = JSON.parse(fs.readFileSync(path.join(levelDir, filename), 'utf8'));
      if (!Array.isArray(json.sections)) throw new Error(`${filename}: sections must be an array`);
      json.level = level;
      json.exam_id = examId;
      items.push({ level, examId, part, filename, json });
    }
  }
  items.sort((a, b) => `${a.level}:${a.examId}:${a.part}`.localeCompare(`${b.level}:${b.examId}:${b.part}`));
  return { items, skipped };
}

async function getContentCounts(client = prisma) {
  const [row] = await client.$queryRawUnsafe(`
    SELECT
      (SELECT COUNT(*)::int FROM jlpt_exam) AS exam_parts,
      (SELECT COUNT(*)::int FROM jlpt_exam_revision) AS revisions,
      (SELECT COUNT(*)::int FROM jlpt_question_explanation) AS question_explanations,
      (SELECT COUNT(*)::int FROM jlpt_passage_explanation) AS passage_explanations,
      (SELECT COUNT(*)::int FROM jlpt_exam_reading_cache) AS readings
  `);
  return row;
}

async function backupTables() {
  const backupDir = path.resolve(
    process.cwd(),
    'backups',
    `jlpt-content-before-import-${options.envName}-${timestamp()}`,
  );
  fs.mkdirSync(backupDir, { recursive: true });
  const tableSpecs = [
    ['jlpt_exam', 'level, exam_id, part'],
    ['jlpt_exam_revision', 'level, exam_id, part, created_at'],
    ['jlpt_exam_question_meta', 'level, exam_id, part, section_index, question_index'],
    ['jlpt_exam_reading_cache', 'level, exam_id, part, section_index, question_index'],
    ['jlpt_question_explanation', 'level, exam_id, part, section_index, question_index, updated_at'],
    ['jlpt_passage_explanation', 'level, exam_id, part, section_index, updated_at'],
  ];
  const counts = {};
  for (const [table, orderBy] of tableSpecs) {
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
    writeJson(path.join(backupDir, `${table}.json`), rows);
    counts[table] = rows.length;
  }
  writeJson(path.join(backupDir, 'manifest.json'), {
    created_at: new Date().toISOString(),
    environment: options.envName,
    input_dir: options.inputDir,
    counts,
  });
  return backupDir;
}

async function main() {
  const { items, skipped } = loadInputFiles(options.inputDir);
  const currentRows = await prisma.jlptExam.findMany();
  const currentByKey = new Map(
    currentRows.map((row) => [`${row.level}:${row.exam_id}:${row.part}`, row]),
  );
  let inserts = 0;
  let updates = 0;
  let unchanged = 0;
  const changedPartKeys = [];
  for (const item of items) {
    const key = `${item.level}:${item.examId}:${item.part}`;
    const current = currentByKey.get(key);
    if (!current) {
      inserts += 1;
      continue;
    }
    if (sameJson(current.json_data, item.json)) unchanged += 1;
    else {
      updates += 1;
      if (!sameJson(contentWithoutEmbeddedExplanation(current.json_data), contentWithoutEmbeddedExplanation(item.json))) {
        changedPartKeys.push({ level: item.level, examId: item.examId, part: item.part });
      }
    }
  }

  const before = await getContentCounts();
  const report = {
    environment: options.envName,
    mode: options.apply ? 'apply' : 'dry-run',
    inputDir: options.inputDir,
    validFiles: items.length,
    skippedFiles: skipped,
    inserts,
    updates,
    unchanged,
    partsWithChangedQuestionContent: changedPartKeys.length,
    before,
  };
  if (!options.apply) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const backupDir = await backupTables();
  await prisma.$transaction(async (tx) => {
    for (const item of items) {
      const current = currentByKey.get(`${item.level}:${item.examId}:${item.part}`);
      if (current) {
        await tx.jlptExamRevision.create({
          data: {
            level: item.level,
            exam_id: item.examId,
            part: item.part,
            editor_id: null,
            note: `bulk import from ${item.filename}`,
            json_data: current.json_data,
          },
        });
      }
      await tx.jlptExam.upsert({
        where: {
          level_exam_id_part: { level: item.level, exam_id: item.examId, part: item.part },
        },
        create: {
          level: item.level,
          exam_id: item.examId,
          part: item.part,
          source_file: item.filename,
          json_data: item.json,
        },
        update: { source_file: item.filename, json_data: item.json },
      });
    }
    for (const key of changedPartKeys) {
      await tx.$executeRawUnsafe(
        `DELETE FROM jlpt_exam_reading_cache WHERE level = $1 AND exam_id = $2 AND part = $3`,
        key.level,
        key.examId,
        key.part,
      );
    }
  }, { timeout: 180000, maxWait: 10000 });

  // Rebuild only structural metadata. This does not touch AI explanation tables.
  const { upsertExamQuestionMetaForPart } = require('../dist/lib/examQuestionMeta.js');
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    await upsertExamQuestionMetaForPart({
      level: item.level,
      examId: item.examId,
      part: item.part,
      jsonData: item.json,
      force: true,
    });
    if ((index + 1) % 25 === 0 || index + 1 === items.length) {
      console.log(`Metadata ${index + 1}/${items.length}`);
    }
  }

  const after = await getContentCounts();
  if (after.question_explanations !== before.question_explanations) {
    throw new Error('Question explanation count changed; backup is available for recovery');
  }
  if (after.passage_explanations !== before.passage_explanations) {
    throw new Error('Passage explanation count changed; backup is available for recovery');
  }
  console.log(JSON.stringify({ ...report, backupDir, after }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
