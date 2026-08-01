#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const ROOT = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const csvPath = path.resolve(ROOT, args.csv || "phucduong_resources_check.csv");
const outDir = path.resolve(ROOT, args.out || "downloads/phucduong");
const concurrency = Math.max(1, Number(args.concurrency || 2));
const limit = args.limit ? Math.max(1, Number(args.limit)) : null;
const startAt = args.start ? Math.max(1, Number(args.start)) : 1;
const dryRun = !args.yes;
const force = Boolean(args.force);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  let items = rows.filter((row) => {
    return row.status === "MO_DUOC_LINK_DRIVE" && row.kind === "drive-file" && row.fileId;
  });

  items = items.filter((row) => Number(row.no) >= startAt);
  if (limit) items = items.slice(0, limit);

  console.log(`CSV: ${csvPath}`);
  console.log(`Output: ${outDir}`);
  console.log(`Items: ${items.length}`);
  console.log(`Mode: ${dryRun ? "dry-run" : "download"}`);
  console.log("");

  if (dryRun) {
    for (const row of items.slice(0, 30)) {
      console.log(`${row.no}. ${row.title}`);
    }
    if (items.length > 30) console.log(`... and ${items.length - 30} more`);
    console.log("");
    console.log("Run with --yes to download. Use --limit 3 first if you want a small test.");
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, "download-log.jsonl");
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const item = items[index++];
      const result = await downloadItem(item).catch((error) => ({
        status: "failed",
        no: item.no,
        title: item.title,
        link: item.link,
        error: error.message,
      }));

      fs.appendFileSync(logPath, `${JSON.stringify(result)}\n`, "utf8");
      const label = result.status === "downloaded" || result.status === "skipped" ? "OK" : "FAIL";
      console.log(`[${label}] ${item.no}. ${item.title} - ${result.status}`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log("");
  console.log(`Log: ${logPath}`);
}

async function downloadItem(item) {
  const prefix = String(item.no).padStart(3, "0");
  const baseName = sanitizeFileName(`${prefix} - ${item.title}`);
  const metaPath = path.join(outDir, `${baseName}.json`);
  const existing = findExistingDownload(baseName);

  if (existing && !force) {
    return {
      status: "skipped",
      no: item.no,
      title: item.title,
      file: existing,
      reason: "already exists",
    };
  }

  const response = await fetchDriveFile(item.fileId);
  const disposition = response.headers.get("content-disposition") || "";
  const type = response.headers.get("content-type") || "";
  const ext = extensionFromHeaders(disposition, type);
  const filePath = path.join(outDir, `${baseName}${ext}`);
  const tempPath = `${filePath}.part`;

  if (response.headers.get("content-type")?.includes("text/html")) {
    const html = await response.text();
    throw new Error(`Google returned HTML instead of a file: ${html.slice(0, 160).replace(/\s+/g, " ")}`);
  }

  if (!response.body) {
    throw new Error("Response did not include a body");
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath));
  fs.renameSync(tempPath, filePath);

  const metadata = {
    no: item.no,
    title: item.title,
    tags: item.tags,
    sourceLink: item.link,
    fileId: item.fileId,
    downloadedAt: new Date().toISOString(),
    contentType: type,
    contentDisposition: disposition,
    file: filePath,
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    status: "downloaded",
    no: item.no,
    title: item.title,
    file: filePath,
    bytes: fs.statSync(filePath).size,
  };
}

async function fetchDriveFile(fileId) {
  const directUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
  const first = await fetch(directUrl, {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0" },
  });

  if (!isHtml(first)) return ensureOk(first);

  const html = await first.text();
  const confirmUrl = parseDriveConfirmUrl(html);
  if (!confirmUrl) {
    throw new Error(`Could not find Drive confirmation form for ${fileId}`);
  }

  const second = await fetch(confirmUrl, {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0" },
  });
  return ensureOk(second);
}

function parseDriveConfirmUrl(html) {
  const formMatch = html.match(/<form[^>]+id=["']download-form["'][^>]+action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) return null;

  const action = formMatch[1].replace(/&amp;/g, "&");
  const inputs = [...formMatch[2].matchAll(/<input[^>]+name=["']([^"']+)["'][^>]+value=["']([^"']*)["'][^>]*>/gi)];
  const url = new URL(action);
  for (const [, name, value] of inputs) {
    url.searchParams.set(name, value.replace(/&amp;/g, "&"));
  }
  return url.toString();
}

function ensureOk(response) {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response;
}

function isHtml(response) {
  return (response.headers.get("content-type") || "").includes("text/html");
}

function extensionFromHeaders(disposition, type) {
  const filename = parseContentDispositionFilename(disposition);
  if (filename) {
    const ext = path.extname(filename);
    if (ext) return ext;
  }
  if (type.includes("pdf")) return ".pdf";
  if (type.includes("zip")) return ".zip";
  if (type.includes("audio/mpeg")) return ".mp3";
  return ".bin";
}

function parseContentDispositionFilename(disposition) {
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ""));
  const plain = disposition.match(/filename=["']?([^"';]+)["']?/i);
  return plain ? plain[1].trim() : "";
}

function findExistingDownload(baseName) {
  if (!fs.existsSync(outDir)) return "";
  const prefix = `${baseName}.`;
  const found = fs.readdirSync(outDir).find((name) => name.startsWith(prefix) && !name.endsWith(".part") && !name.endsWith(".json"));
  return found ? path.join(outDir, found) : "";
}

function sanitizeFileName(name) {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  return rows
    .filter((values) => values.length && values.some(Boolean))
    .map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] || ""])));
}
