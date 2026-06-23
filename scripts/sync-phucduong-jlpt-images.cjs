const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const envName = args.find((arg) => arg.startsWith('--env='))?.slice('--env='.length) || 'production';
const envFile = path.resolve(process.cwd(), envName === 'local' ? '.env.local' : `.env.${envName}`);
dotenv.config({ path: envFile, override: true });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const SOURCE = 'https://www.phucduong.xyz';
const PUBLIC_DIR = path.resolve(process.cwd(), '..', 'vocab-frontend', 'public');
const CONCURRENCY = 6;

function imageKind(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buffer.subarray(0, 6).toString().startsWith('GIF8')) return 'gif';
  const prefix = buffer.subarray(0, 300).toString('utf8').trim().toLowerCase();
  if (prefix.startsWith('<svg') || (prefix.startsWith('<?xml') && prefix.includes('<svg'))) return 'svg';
  return null;
}

function isValidLocalImage(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  return Boolean(imageKind(fs.readFileSync(filePath)));
}

function candidatePaths(imagePath) {
  const extension = path.posix.extname(imagePath);
  const stem = extension ? imagePath.slice(0, -extension.length) : imagePath;
  return [imagePath, ...['.png', '.jpg', '.jpeg', '.webp'].map((next) => `${stem}${next}`)]
    .filter((item, index, all) => all.indexOf(item) === index);
}

function collectImageRefs(value, examKey, refs) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/(?:src|href)\s*=\s*["'](\/images\/jlpt\/[^"']+)["']/gi)) {
      const imagePath = match[1].split(/[?#]/)[0];
      if (!refs.has(imagePath)) refs.set(imagePath, new Set());
      refs.get(imagePath).add(examKey);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageRefs(item, examKey, refs));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectImageRefs(item, examKey, refs));
  }
}

async function runPool(items, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  }));
}

async function main() {
  const rows = await prisma.jlptExam.findMany({
    select: { level: true, exam_id: true, part: true, json_data: true },
  });
  const refs = new Map();
  rows.forEach((row) => {
    collectImageRefs(row.json_data, `${row.level}-${row.exam_id}-part${row.part}`, refs);
  });

  const invalid = [...refs.entries()].filter(([imagePath]) => {
    return !isValidLocalImage(path.join(PUBLIC_DIR, imagePath.replace(/^\//, '')));
  });
  const downloaded = [];
  const resolvedAliases = [];
  const unavailable = [];

  await runPool(invalid, async ([imagePath, examKeys], index) => {
    try {
      let lastResponse = null;
      for (const candidatePath of candidatePaths(imagePath)) {
        const candidateOutput = path.join(PUBLIC_DIR, candidatePath.replace(/^\//, ''));
        if (candidatePath !== imagePath && isValidLocalImage(candidateOutput)) {
          resolvedAliases.push({ imagePath, resolvedPath: candidatePath, source: 'local', examKeys: [...examKeys] });
          return;
        }
        const response = await fetch(`${SOURCE}${candidatePath}`, {
          headers: { Accept: 'image/*', 'User-Agent': 'vocab-frontend-jlpt-image-sync/1.0' },
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        const kind = imageKind(buffer);
        lastResponse = response;
        if (!response.ok || !kind) continue;
        if (apply) {
          fs.mkdirSync(path.dirname(candidateOutput), { recursive: true });
          fs.writeFileSync(candidateOutput, buffer);
        }
        downloaded.push({ imagePath, resolvedPath: candidatePath, bytes: buffer.length, kind, examKeys: [...examKeys] });
        if (candidatePath !== imagePath) {
          resolvedAliases.push({ imagePath, resolvedPath: candidatePath, source: 'download', examKeys: [...examKeys] });
        }
        if ((index + 1) % 20 === 0) console.log(`Checked ${index + 1}/${invalid.length}`);
        return;
      }
      unavailable.push({
        imagePath,
        status: lastResponse?.status || 0,
        contentType: lastResponse?.headers.get('content-type') || null,
        examKeys: [...examKeys],
      });
    } catch (error) {
      unavailable.push({ imagePath, status: 0, error: error.message, examKeys: [...examKeys] });
    }
  });

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    examParts: rows.length,
    uniqueReferences: refs.size,
    alreadyValid: refs.size - invalid.length,
    checked: invalid.length,
    downloaded: downloaded.length,
    resolvedAliases: resolvedAliases.length,
    unavailable: unavailable.length,
    downloadedItems: downloaded,
    resolvedAliasItems: resolvedAliases,
    unavailableItems: unavailable,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
