/* eslint-disable no-console */
const fs = require("node:fs/promises");
const path = require("node:path");
const { PrismaClient, Prisma } = require("@prisma/client");

const prisma = new PrismaClient();

const dataDir =
  process.env.LISTENING_DATA_DIR ||
  path.resolve(process.cwd(), "..", "vocab-frontend", "src", "data", "listening");
const videosPath = path.join(dataDir, "corodomoVideos.json");
const transcriptsPath = path.join(dataDir, "corodomoTranscripts.json");

function asDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function deriveLevelsFromTitle(title = "") {
  const text = String(title || "").toLowerCase();
  const found = new Set();
  const order = ["n5", "n4", "n3", "n2", "n1"];

  const direct = text.match(/n\s*[1-5]/g) || [];
  for (const token of direct) {
    const num = token.replace(/\D+/g, "");
    if (num) {
      found.add(`n${num}`);
    }
  }

  const rangeRegex = /n\s*([1-5])\s*[-~〜]\s*([1-5])/g;
  let m = rangeRegex.exec(text);
  while (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const from = Math.min(a, b);
      const to = Math.max(a, b);
      for (let i = from; i <= to; i += 1) {
        found.add(`n${i}`);
      }
    }
    m = rangeRegex.exec(text);
  }

  return order.filter((level) => found.has(level));
}

function normalizeVideo(raw) {
  const videoId = String(raw?.videoId || "").trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return null;
  }
  return {
    source_id: String(raw?.id || "").trim() || null,
    video_id: videoId,
    title: String(raw?.title || "").trim() || "Untitled video",
    duration_sec: Number(raw?.durationSec || 0),
    thumbnail: String(raw?.thumbnail || "").trim() || null,
    levels: Array.isArray(raw?.levels) ? raw.levels.map((item) => String(item).toLowerCase()) : [],
    normalized_levels: deriveLevelsFromTitle(raw?.title),
    tags: Array.isArray(raw?.tags) ? raw.tags.map((item) => String(item)) : [],
    category_label: String(raw?.categoryLabel || "").trim() || null,
    created_relative: String(raw?.createdRelative || "").trim() || null,
    views: BigInt(Number(raw?.views || 0)),
    created_at_src: asDateOrNull(raw?.createdAt),
    updated_at_src: asDateOrNull(raw?.updatedAt),
    video_url: String(raw?.videoUrl || "").trim() || `https://www.youtube.com/watch?v=${videoId}`,
    embed_url: String(raw?.embedUrl || "").trim() || `https://www.youtube.com/embed/${videoId}`,
  };
}

function normalizeLines(videoId, transcriptData) {
  const rows = transcriptData?.data?.[videoId]?.lines;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((line, index) => ({
    video_id: videoId,
    line_index: index,
    text: String(line?.text || ""),
    start_sec: Number.isFinite(Number(line?.start)) ? Number(line.start) : null,
    end_sec: Number.isFinite(Number(line?.end)) ? Number(line.end) : null,
    dur_sec: Number.isFinite(Number(line?.dur)) ? Number(line.dur) : null,
    ruby_html: String(line?.rubyHtml || "") || null,
  }));
}

function sqlQuote(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumberOrNull(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : "NULL";
}

async function ensureTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS listening_video (
      id BIGSERIAL PRIMARY KEY,
      source_id VARCHAR(100),
      video_id VARCHAR(20) NOT NULL UNIQUE,
      source_order INTEGER NULL,
      title TEXT NOT NULL,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      thumbnail TEXT,
      levels TEXT[] NOT NULL DEFAULT '{}',
      normalized_levels TEXT[] NOT NULL DEFAULT '{}',
      tags TEXT[] NOT NULL DEFAULT '{}',
      category_label VARCHAR(100),
      created_relative VARCHAR(50),
      views BIGINT NOT NULL DEFAULT 0,
      created_at_src TIMESTAMP NULL,
      updated_at_src TIMESTAMP NULL,
      video_url TEXT,
      embed_url TEXT,
      inserted_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE listening_video
    ADD COLUMN IF NOT EXISTS source_order INTEGER NULL;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE listening_video
    ADD COLUMN IF NOT EXISTS normalized_levels TEXT[] NOT NULL DEFAULT '{}';
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS listening_transcript_line (
      id BIGSERIAL PRIMARY KEY,
      video_id VARCHAR(20) NOT NULL,
      line_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      start_sec DOUBLE PRECISION NULL,
      end_sec DOUBLE PRECISION NULL,
      dur_sec DOUBLE PRECISION NULL,
      ruby_html TEXT NULL,
      inserted_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT listening_transcript_line_video_fk
        FOREIGN KEY (video_id) REFERENCES listening_video(video_id) ON DELETE CASCADE,
      CONSTRAINT listening_transcript_line_video_line_uniq UNIQUE(video_id, line_index)
    );
  `);
}

async function main() {
  await ensureTables();
  const videosRaw = JSON.parse(await fs.readFile(videosPath, "utf8"));
  const transcriptRaw = JSON.parse(await fs.readFile(transcriptsPath, "utf8"));
  const videos = Array.isArray(videosRaw) ? videosRaw.map(normalizeVideo).filter(Boolean) : [];

  let importedVideos = 0;
  let importedLines = 0;

  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO listening_video (
          source_id, video_id, source_order, title, duration_sec, thumbnail, levels, normalized_levels, tags, category_label,
          created_relative, views, created_at_src, updated_at_src, video_url, embed_url, updated_at
        ) VALUES (
          ${video.source_id}, ${video.video_id}, ${index}, ${video.title}, ${video.duration_sec}, ${video.thumbnail},
          ${video.levels}, ${video.normalized_levels}, ${video.tags}, ${video.category_label}, ${video.created_relative}, ${video.views},
          ${video.created_at_src}, ${video.updated_at_src}, ${video.video_url}, ${video.embed_url}, NOW()
        )
        ON CONFLICT (video_id) DO UPDATE SET
          source_id = EXCLUDED.source_id,
          source_order = EXCLUDED.source_order,
          title = EXCLUDED.title,
          duration_sec = EXCLUDED.duration_sec,
          thumbnail = EXCLUDED.thumbnail,
          levels = EXCLUDED.levels,
          normalized_levels = EXCLUDED.normalized_levels,
          tags = EXCLUDED.tags,
          category_label = EXCLUDED.category_label,
          created_relative = EXCLUDED.created_relative,
          views = EXCLUDED.views,
          created_at_src = EXCLUDED.created_at_src,
          updated_at_src = EXCLUDED.updated_at_src,
          video_url = EXCLUDED.video_url,
          embed_url = EXCLUDED.embed_url,
          updated_at = NOW()
      `,
    );
    importedVideos += 1;

    const lines = normalizeLines(video.video_id, transcriptRaw);
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM listening_transcript_line WHERE video_id = ${video.video_id}`,
    );
    if (lines.length > 0) {
      const values = lines
        .map(
          (line) =>
            `(${sqlQuote(line.video_id)}, ${line.line_index}, ${sqlQuote(line.text)}, ${sqlNumberOrNull(
              line.start_sec,
            )}, ${sqlNumberOrNull(line.end_sec)}, ${sqlNumberOrNull(line.dur_sec)}, ${sqlQuote(
              line.ruby_html,
            )})`,
        )
        .join(",\n");
      await prisma.$executeRawUnsafe(`
        INSERT INTO listening_transcript_line (
          video_id, line_index, text, start_sec, end_sec, dur_sec, ruby_html
        ) VALUES
        ${values}
      `);
    }
    importedLines += lines.length;

    if (importedVideos % 50 === 0 || importedVideos === videos.length) {
      console.log(`Imported ${importedVideos}/${videos.length} videos`);
    }
  }

  console.log(
    `Done. videos=${importedVideos}, transcriptLines=${importedLines}. JSON files were kept unchanged.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
