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
const translationsPath = path.join(dataDir, "corodomoTranslations.json");
const corodomoVocabularyPath = path.join(dataDir, "corodomoVocabulary.json");

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

function normalizeTranslationLines(videoId, translationData) {
  const byLanguage = translationData?.data?.[videoId];
  if (!byLanguage || typeof byLanguage !== "object") {
    return [];
  }

  const lines = [];
  for (const [language, entry] of Object.entries(byLanguage)) {
    const rows = entry?.lines;
    if (!/^[a-z]{2,10}$/i.test(language) || !Array.isArray(rows)) {
      continue;
    }
    rows.forEach((line, index) => {
      const translation = String(line?.text || line?.translation || "").trim();
      if (!translation) return;
      lines.push({
        video_id: videoId,
        line_index: index,
        language: language.toLowerCase(),
        source_text: "",
        translation,
        provider: "corodomo",
      });
    });
  }
  return lines;
}

function normalizeCorodomoVocabulary(vocabularyData) {
  const rawItems = vocabularyData?.data;
  const items = Array.isArray(rawItems)
    ? rawItems
    : rawItems && typeof rawItems === "object"
      ? Object.values(rawItems)
      : [];

  const out = [];
  const seen = new Set();
  for (const item of items) {
    const text = String(item?.text || "").replace(/\s+/g, " ").trim();
    const lang = String(item?.lang || "ja").trim().toLowerCase() || "ja";
    const targetLang = String(item?.targetLang || item?.target_lang || "vi").trim().toLowerCase() || "vi";
    const translation = String(item?.translation || "").replace(/\s+/g, " ").trim();
    const pos = String(item?.pos || "").replace(/\s+/g, " ").trim();
    const level = String(item?.level || "").replace(/\s+/g, " ").trim();
    const sourceQuery = String(item?.sourceQuery || item?.source_query || "").replace(/\s+/g, " ").trim();
    if (!text || !translation || !/^[a-z]{2,10}$/i.test(lang) || !/^[a-z]{2,10}$/i.test(targetLang)) {
      continue;
    }
    const key = `${text}::${lang}::${targetLang}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, lang, targetLang, translation, pos, level, sourceQuery });
  }
  return out;
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
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS listening_transcript_translation (
      id BIGSERIAL PRIMARY KEY,
      video_id VARCHAR(20) NOT NULL,
      line_index INTEGER NOT NULL,
      language VARCHAR(10) NOT NULL,
      source_text TEXT NOT NULL,
      translation TEXT NOT NULL,
      provider VARCHAR(50) NOT NULL DEFAULT 'corodomo',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT listening_transcript_translation_video_fk
        FOREIGN KEY (video_id) REFERENCES listening_video(video_id) ON DELETE CASCADE,
      CONSTRAINT listening_transcript_translation_line_lang_uniq UNIQUE(video_id, line_index, language)
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_listening_transcript_translation_lookup
    ON listening_transcript_translation (video_id, line_index, language);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS listening_corodomo_vocabulary (
      id BIGSERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      lang VARCHAR(10) NOT NULL DEFAULT 'ja',
      target_lang VARCHAR(10) NOT NULL DEFAULT 'vi',
      translation TEXT NOT NULL,
      pos TEXT,
      level VARCHAR(50),
      source_query TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT listening_corodomo_vocabulary_text_lang_uniq UNIQUE(text, lang, target_lang)
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_listening_corodomo_vocabulary_lookup
    ON listening_corodomo_vocabulary (text, lang, target_lang);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE listening_corodomo_vocabulary
    ADD COLUMN IF NOT EXISTS pos TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE listening_corodomo_vocabulary
    ADD COLUMN IF NOT EXISTS level VARCHAR(50);
  `);
}

async function main() {
  await ensureTables();
  const videosRaw = JSON.parse(await fs.readFile(videosPath, "utf8"));
  const transcriptRaw = JSON.parse(await fs.readFile(transcriptsPath, "utf8"));
  let translationRaw = { data: {} };
  try {
    translationRaw = JSON.parse(await fs.readFile(translationsPath, "utf8"));
  } catch {
    translationRaw = { data: {} };
  }
  let corodomoVocabularyRaw = { data: {} };
  try {
    corodomoVocabularyRaw = JSON.parse(await fs.readFile(corodomoVocabularyPath, "utf8"));
  } catch {
    corodomoVocabularyRaw = { data: {} };
  }
  const videos = Array.isArray(videosRaw) ? videosRaw.map(normalizeVideo).filter(Boolean) : [];

  let importedVideos = 0;
  let importedLines = 0;
  let importedTranslations = 0;
  let importedCorodomoVocabulary = 0;

  const corodomoVocabulary = normalizeCorodomoVocabulary(corodomoVocabularyRaw);
  for (let index = 0; index < corodomoVocabulary.length; index += 500) {
    const chunk = corodomoVocabulary.slice(index, index + 500);
    const rows = Prisma.join(
      chunk.map(
        (item) =>
          Prisma.sql`(${item.text}, ${item.lang}, ${item.targetLang}, ${item.translation}, ${item.pos}, ${item.level}, ${item.sourceQuery}, NOW(), NOW())`,
      ),
    );
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO listening_corodomo_vocabulary (
          text, lang, target_lang, translation, pos, level, source_query, created_at, updated_at
        ) VALUES ${rows}
        ON CONFLICT (text, lang, target_lang)
        DO UPDATE SET
          translation = EXCLUDED.translation,
          pos = EXCLUDED.pos,
          level = EXCLUDED.level,
          source_query = EXCLUDED.source_query,
          updated_at = NOW()
      `,
    );
    importedCorodomoVocabulary += chunk.length;
  }

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
      const rows = Prisma.join(
        lines.map(
          (line) =>
            Prisma.sql`(${line.video_id}, ${line.line_index}, ${line.text}, ${line.start_sec}, ${line.end_sec}, ${line.dur_sec}, ${line.ruby_html})`,
        ),
      );
      await prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO listening_transcript_line (
            video_id, line_index, text, start_sec, end_sec, dur_sec, ruby_html
          ) VALUES ${rows}
        `,
      );
    }
    importedLines += lines.length;

    const translationLines = normalizeTranslationLines(video.video_id, translationRaw);
    if (translationLines.length > 0) {
      const sourceByIndex = new Map(lines.map((line) => [line.line_index, line.text]));
      const rows = Prisma.join(
        translationLines.map((line) => {
          const sourceText = sourceByIndex.get(line.line_index) || line.source_text || "";
          return Prisma.sql`(${line.video_id}, ${line.line_index}, ${line.language}, ${sourceText}, ${line.translation}, ${line.provider}, NOW(), NOW())`;
        }),
      );
      await prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO listening_transcript_translation (
            video_id, line_index, language, source_text, translation, provider, created_at, updated_at
          ) VALUES ${rows}
          ON CONFLICT (video_id, line_index, language)
          DO UPDATE SET
            source_text = EXCLUDED.source_text,
            translation = EXCLUDED.translation,
            provider = EXCLUDED.provider,
            updated_at = NOW()
        `,
      );
    }
    importedTranslations += translationLines.length;

    if (importedVideos % 50 === 0 || importedVideos === videos.length) {
      console.log(`Imported ${importedVideos}/${videos.length} videos`);
    }
  }

  console.log(
    `Done. videos=${importedVideos}, transcriptLines=${importedLines}, translationLines=${importedTranslations}, corodomoVocabulary=${importedCorodomoVocabulary}. JSON files were kept unchanged.`,
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
