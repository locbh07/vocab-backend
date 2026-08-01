/* eslint-disable no-console */
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const dotenv = require("dotenv");
const { PrismaClient, Prisma } = require("@prisma/client");
const youtubeDl = require("youtube-dl-exec");

dotenv.config({ path: ".env.local" });
dotenv.config();

const prisma = new PrismaClient();

function parseArgs(argv) {
  const out = {
    limit: 10,
    videoIds: [],
    checkAsr: true,
    fetchTimeoutMs: 120000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") out.limit = Math.max(1, Number(argv[++index] || out.limit));
    else if (arg === "--video-ids") {
      out.videoIds = String(argv[++index] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (arg === "--no-asr-check") out.checkAsr = false;
    else if (arg === "--timeout-ms") out.fetchTimeoutMs = Math.max(10000, Number(argv[++index] || out.fetchTimeoutMs));
  }
  return out;
}

function normalizeText(input) {
  return String(input || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .replace(/[。、,.，．!?！？「」『』（）()[\]【】"'“”‘’]/g, "")
    .toLowerCase();
}

function lcsSimilarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  const short = left.length <= right.length ? left : right;
  const long = left.length <= right.length ? right : left;
  const previous = new Array(long.length + 1).fill(0);
  const current = new Array(long.length + 1).fill(0);
  for (let i = 1; i <= short.length; i += 1) {
    for (let j = 1; j <= long.length; j += 1) {
      current[j] = short[i - 1] === long[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    for (let j = 0; j <= long.length; j += 1) previous[j] = current[j];
  }
  return previous[long.length] / Math.max(left.length, right.length);
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarizeDiffs(values) {
  if (!values.length) return null;
  return {
    medianSec: Number(percentile(values, 0.5).toFixed(3)),
    p90Sec: Number(percentile(values, 0.9).toFixed(3)),
    maxSec: Number(Math.max(...values).toFixed(3)),
  };
}

async function pickVideos(options) {
  if (options.videoIds.length) {
    return prisma.$queryRaw(
      Prisma.sql`
        SELECT video_id, title, duration_sec
        FROM listening_video
        WHERE video_id IN (${Prisma.join(options.videoIds)})
        ORDER BY inserted_at ASC
      `,
    );
  }
  return prisma.$queryRaw`
    SELECT video_id, title, duration_sec
    FROM listening_video
    WHERE duration_sec > 0
    ORDER BY inserted_at ASC
    LIMIT ${options.limit}
  `;
}

async function loadDbLines(videoId) {
  return prisma.$queryRaw`
    SELECT line_index, text, start_sec, end_sec, dur_sec
    FROM listening_transcript_line
    WHERE video_id = ${videoId}
    ORDER BY line_index ASC
  `;
}

async function fetchYoutubeJson3(videoId, timeoutMs) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "listening-karaoke-audit-"));
  try {
    await youtubeDl.exec(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        skipDownload: true,
        writeSub: true,
        writeAutoSub: true,
        subLang: "ja",
        subFormat: "json3",
        output: path.join(tempDir, "%(id)s.%(ext)s"),
        noPlaylist: true,
        noWarnings: true,
        quiet: true,
      },
      { timeout: timeoutMs },
    );
    const files = await fs.readdir(tempDir);
    const json3File = files.find((file) => file.endsWith(".ja.json3")) || files.find((file) => file.endsWith(".json3"));
    if (!json3File) return null;
    return JSON.parse(await fs.readFile(path.join(tempDir, json3File), "utf8"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseYoutubeEvents(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return events
    .map((event) => {
      const segs = Array.isArray(event?.segs) ? event.segs : [];
      const textSegs = segs
        .map((seg) => ({
          text: String(seg?.utf8 || ""),
          offsetMs: Number.isFinite(Number(seg?.tOffsetMs)) ? Number(seg.tOffsetMs) : null,
        }))
        .filter((seg) => seg.text.trim());
      const text = textSegs.map((seg) => seg.text).join("").replace(/\s+/g, " ").trim();
      const startMs = Number(event?.tStartMs);
      const durMs = Number(event?.dDurationMs);
      const start = Number.isFinite(startMs) ? startMs / 1000 : null;
      const dur = Number.isFinite(durMs) ? durMs / 1000 : null;
      return {
        text,
        start,
        end: start !== null && dur !== null ? start + dur : null,
        dur,
        textSegs,
      };
    })
    .filter((event) => event.text && event.start !== null);
}

function compareYoutubeToDb(youtubeEvents, dbLines) {
  const matched = [];
  for (const event of youtubeEvents) {
    let best = null;
    for (const line of dbLines) {
      const lineStart = Number(line.start_sec);
      if (Number.isFinite(lineStart) && Math.abs(lineStart - event.start) > 30) continue;
      const similarity = lcsSimilarity(event.text, line.text);
      if (!best || similarity > best.similarity) {
        best = { line, similarity };
      }
    }
    if (!best || best.similarity < 0.35) continue;
    const startDiff = Math.abs(Number(best.line.start_sec) - event.start);
    const dbEnd = Number(best.line.end_sec);
    const endDiff = event.end !== null && Number.isFinite(dbEnd) ? Math.abs(dbEnd - event.end) : null;
    matched.push({
      similarity: best.similarity,
      startDiff,
      endDiff,
    });
  }
  return matched;
}

function checkCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0;
}

function checkAsrAndAlignerCapabilities() {
  return {
    openAiApiKeyPresent: Boolean(String(process.env.OPENAI_API_KEY || "").trim()),
    pythonPresent: checkCommand("python", ["--version"]),
    whisperxInstalled: checkCommand("python", ["-c", "import whisperx"]),
    aeneasInstalled: checkCommand("python", ["-c", "import aeneas"]),
    montrealForcedAlignerInstalled: checkCommand("mfa", ["version"]),
  };
}

async function auditVideo(video, options) {
  const dbLines = await loadDbLines(video.video_id);
  const payload = await fetchYoutubeJson3(video.video_id, options.fetchTimeoutMs);
  const youtubeEvents = payload ? parseYoutubeEvents(payload) : [];
  const textSegs = youtubeEvents.flatMap((event) => event.textSegs);
  const segsWithOffset = textSegs.filter((seg) => seg.offsetMs !== null);
  const eventsWithMultipleTimedSegs = youtubeEvents.filter(
    (event) => event.textSegs.filter((seg) => seg.offsetMs !== null).length > 1,
  );
  const matched = compareYoutubeToDb(youtubeEvents, dbLines);
  const startDiffs = matched.map((item) => item.startDiff).filter(Number.isFinite);
  const endDiffs = matched.map((item) => item.endDiff).filter(Number.isFinite);
  const similarities = matched.map((item) => item.similarity).filter(Number.isFinite);

  return {
    videoId: video.video_id,
    title: video.title,
    durationSec: Number(video.duration_sec || 0),
    dbLineCount: dbLines.length,
    youtubeEventCount: youtubeEvents.length,
    youtubeTextSegmentCount: textSegs.length,
    youtubeTimedTextSegmentCount: segsWithOffset.length,
    youtubeTimedSegmentCoverage:
      textSegs.length > 0 ? Number(((segsWithOffset.length / textSegs.length) * 100).toFixed(2)) : 0,
    youtubeEventsWithMultipleTimedSegments: eventsWithMultipleTimedSegs.length,
    matchedEventCount: matched.length,
    averageTextSimilarity:
      similarities.length > 0
        ? Number((similarities.reduce((sum, value) => sum + value, 0) / similarities.length).toFixed(3))
        : null,
    startDiff: summarizeDiffs(startDiffs),
    endDiff: summarizeDiffs(endDiffs),
    verdict:
      eventsWithMultipleTimedSegs.length > 0
        ? "YOUTUBE_SEGMENT_TIMING_USABLE"
        : "LINE_TIMING_ONLY_NEEDS_ASR_OR_FORCED_ALIGNMENT",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const videos = await pickVideos(options);
  const results = [];
  for (const video of videos) {
    console.log(`Auditing ${video.video_id} - ${String(video.title || "").slice(0, 80)}`);
    try {
      results.push(await auditVideo(video, options));
    } catch (error) {
      results.push({
        videoId: video.video_id,
        title: video.title,
        durationSec: Number(video.duration_sec || 0),
        error: String(error?.stderr || error?.message || error),
        verdict: "YOUTUBE_JSON3_FETCH_FAILED",
      });
    }
  }

  const usable = results.filter((item) => item.verdict === "YOUTUBE_SEGMENT_TIMING_USABLE").length;
  const summary = {
    generatedAt: new Date().toISOString(),
    checkedVideos: results.length,
    youtubeSegmentTimingUsableVideos: usable,
    youtubeSegmentTimingUsableRate: results.length ? Number(((usable / results.length) * 100).toFixed(2)) : 0,
    asrAndAlignerCapabilities: options.checkAsr ? checkAsrAndAlignerCapabilities() : null,
    results,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
