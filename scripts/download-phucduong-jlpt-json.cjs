const fs = require('fs');
const path = require('path');

const API_URL = 'https://phucduong-api.vercel.app/api/storage';
const BUCKET = 'jlpt';
const LEVELS = new Set(['N1', 'N2', 'N3', 'N4', 'N5']);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 6));
const TIMEOUT_MS = Math.max(1000, Number(process.env.TIMEOUT_MS || 30000));
const RETRIES = Math.max(1, Number(process.env.RETRIES || 3));

function parseOutputDir() {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf('--output');
  const assignment = args.find((arg) => arg.startsWith('--output='));
  const value = flagIndex >= 0
    ? args[flagIndex + 1]
    : assignment?.slice('--output='.length) || args.find((arg) => !arg.startsWith('-'));
  const defaultName = `phucduong-jlpt-json-${new Date().toISOString().slice(0, 10)}`;
  return path.resolve(process.cwd(), value || path.join('downloads', defaultName));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'vocab-backend-jlpt-downloader/1.0' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, label) {
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw new Error(`${label}: ${lastError?.message || 'download failed'}`);
}

function storageUrl(params) {
  const query = new URLSearchParams(params);
  return `${API_URL}?${query}`;
}

function safeFilename(filename) {
  return path.basename(filename).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function detectLevel(filename, examJson) {
  const fromContent = String(examJson?.level || '').trim().toUpperCase();
  if (LEVELS.has(fromContent)) return fromContent;
  const fromName = filename.match(/(?:^|[-_])(N[1-5])(?:[-_]|$)/i)?.[1]?.toUpperCase();
  return LEVELS.has(fromName) ? fromName : null;
}

async function runPool(items, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const outputDir = parseOutputDir();
  if (fs.existsSync(outputDir)) throw new Error(`Output folder already exists: ${outputDir}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const listing = await fetchJson(
    storageUrl({ action: 'list', bucket: BUCKET }),
    'Cannot list JLPT files',
  );
  const files = (listing.files || [])
    .map((entry) => String(entry.name || '').trim())
    .filter((name) => name.toLowerCase().endsWith('.json'));
  if (!files.length) throw new Error('The JLPT bucket did not return any JSON files');

  const counts = { N1: 0, N2: 0, N3: 0, N4: 0, N5: 0 };
  const failures = [];
  let completed = 0;

  await runPool(files, async (filename) => {
    try {
      const payload = await fetchJson(
        storageUrl({ action: 'get', bucket: BUCKET, path: filename }),
        filename,
      );
      const content = typeof payload.content === 'string'
        ? payload.content
        : JSON.stringify(payload.content, null, 2);
      const parsed = JSON.parse(content);
      const level = detectLevel(filename, parsed);
      if (!level) throw new Error('Cannot determine JLPT level from JSON content or filename');

      const levelDir = path.join(outputDir, level);
      fs.mkdirSync(levelDir, { recursive: true });
      fs.writeFileSync(path.join(levelDir, safeFilename(filename)), `${content.trimEnd()}\n`, 'utf8');
      counts[level] += 1;
      completed += 1;
      if (completed % 25 === 0 || completed === files.length) {
        console.log(`Downloaded ${completed}/${files.length}`);
      }
    } catch (error) {
      failures.push({ filename, error: error.message });
    }
  });

  if (failures.length) {
    throw new Error(`Failed ${failures.length} files:\n${JSON.stringify(failures, null, 2)}`);
  }
  console.log(JSON.stringify({ outputDir, total: completed, levels: counts }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
