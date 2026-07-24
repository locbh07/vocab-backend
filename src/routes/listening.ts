import { Request, Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import youtubeDl from 'youtube-dl-exec';
import { prisma } from '../lib/prisma';
import { resolveContentAccess } from '../lib/contentAccess';
import { listeningVideoMaskRule } from '../lib/contentMasking';
import { tokenizeJapaneseText } from '../lib/japaneseReading';

type ListeningVideoRow = {
  source_id: string | null;
  video_id: string;
  title: string;
  duration_sec: number;
  thumbnail: string | null;
  levels: string[] | null;
  normalized_levels: string[] | null;
  tags: string[] | null;
  category_label: string | null;
  created_relative: string | null;
  views: bigint | number | null;
  created_at_src: Date | null;
  updated_at_src: Date | null;
  video_url: string | null;
  embed_url: string | null;
  is_free_preview: boolean | null;
};

type TranscriptRow = {
  line_index: number;
  text: string;
  start_sec: number | null;
  end_sec: number | null;
  dur_sec: number | null;
  ruby_html: string | null;
};

type TranscriptTranslationLineRow = {
  line_index: number;
  language: string;
  translation: string;
};

type StoredTranslationRow = {
  translation: string;
};

type YoutubeTranscriptLine = {
  text: string;
  start: number | null;
  end: number | null;
  dur: number | null;
};

type YoutubeImportResult = {
  videoId: string;
  title: string;
  durationSec: number;
  thumbnail: string;
  views: number;
  lines: YoutubeTranscriptLine[];
  transcriptSource: string;
};

type YoutubeImportOptions = {
  allowAiTranscript?: boolean;
};

type ListeningVocabLookupRow = {
  id: bigint | number;
  word_ja: string | null;
  word_hira_kana: string | null;
  word_romaji: string | null;
  word_vi: string | null;
  audio_url: string | null;
  level: string | null;
  topic: string | null;
};

type ListeningCorodomoVocabLookupRow = {
  id: bigint | number;
  text: string | null;
  lang: string | null;
  translation: string | null;
  pos: string | null;
  level: string | null;
};

type ListeningVocabLookupWord = ReturnType<typeof mapLookupWord>;

type ListeningVocabLookupToken = {
  surface: string;
  basic: string;
  reading: string;
  pos: string;
  posDetail: string;
};

const LISTENING_FREE_VIDEO_LIMIT_PER_LEVEL = Math.max(1, Number(process.env.LISTENING_FREE_VIDEO_LIMIT_PER_LEVEL || 15));
const REQUIRE_PREMIUM_FOR_YOUTUBE_IMPORT = String(process.env.LISTENING_YOUTUBE_IMPORT_REQUIRE_PREMIUM || 'true').toLowerCase() !== 'false';
const LISTENING_AI_TRANSCRIPT_ENABLED = String(process.env.LISTENING_AI_TRANSCRIPT_ENABLED || 'true').toLowerCase() !== 'false';
const LISTENING_AI_TRANSCRIPT_MODEL = String(process.env.OPENAI_LISTENING_TRANSCRIBE_MODEL || process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1').trim();
const LISTENING_AI_TRANSCRIPT_LANGUAGE = String(process.env.LISTENING_AI_TRANSCRIPT_LANGUAGE || 'ja').trim();
const LISTENING_AI_TRANSCRIPT_MAX_DURATION_SEC = Math.max(30, Number(process.env.LISTENING_AI_TRANSCRIPT_MAX_DURATION_SEC || 45 * 60));
const LISTENING_AI_TRANSCRIPT_MAX_AUDIO_BYTES = Math.max(1024 * 1024, Number(process.env.LISTENING_AI_TRANSCRIPT_MAX_AUDIO_BYTES || 24 * 1024 * 1024));
const SUPPORTED_TRANSLATION_LANGUAGES = new Set(['vi', 'en']);
const translationCache = new Map<string, string>();
const MAX_TRANSLATION_CACHE_SIZE = 1000;
const LISTENING_VOCAB_LOOKUP_MAX_LINES = 400;
const LISTENING_VOCAB_LOOKUP_MAX_TEXT_LENGTH = 120;
const LISTENING_VOCAB_LOOKUP_MAX_NGRAM = 8;
const TRANSCRIPT_LINE_CORRECTIONS = new Map([
  ['串で紙を溶かします', '櫛で髪をとかします'],
  ['櫛で髪を溶かします', '櫛で髪をとかします'],
]);
const COMB_HAIR_RUBY_HTML =
  '<ruby>櫛<rt>くし</rt></ruby>で<ruby>髪<rt>かみ</rt></ruby>をとかします';
let ensureListeningTranslationTablePromise: Promise<void> | null = null;
let ensureListeningCorodomoVocabularyTablePromise: Promise<void> | null = null;
let ensureListeningSummaryTablePromise: Promise<void> | null = null;

function normalizeLevel(input: unknown) {
  return String(input || '').trim().toLowerCase();
}

function isPremiumRole(role: unknown) {
  const normalized = String(role || '').trim().toUpperCase();
  return normalized.includes('ADMIN') || normalized.includes('PREMIUM');
}

function mapVideo(row: ListeningVideoRow) {
  const normalizedLevels = Array.isArray(row.normalized_levels) ? row.normalized_levels : [];
  const sourceLevels = Array.isArray(row.levels) ? row.levels : [];
  const levels = normalizedLevels.length > 0 ? normalizedLevels : sourceLevels;
  return {
    id: row.source_id || `db-${row.video_id}`,
    videoId: row.video_id,
    title: row.title,
    durationSec: Number(row.duration_sec || 0),
    thumbnail: row.thumbnail || '',
    levels,
    sourceLevels,
    tags: Array.isArray(row.tags) ? row.tags : [],
    categoryLabel: row.category_label || '',
    createdRelative: row.created_relative || '',
    views: Number(row.views || 0),
    createdAt: row.created_at_src,
    updatedAt: row.updated_at_src,
    videoUrl: row.video_url || `https://www.youtube.com/watch?v=${row.video_id}`,
    embedUrl: row.embed_url || `https://www.youtube.com/embed/${row.video_id}`,
    isFreePreview: Boolean(row.is_free_preview),
  };
}

function listeningVideoLevels(item: { levels?: unknown }): string[] {
  return Array.from(
    new Set(
      (Array.isArray(item.levels) ? item.levels : [])
        .map((level) => String(level || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function unlockedListeningVideoIdsByLevel(
  items: Array<{ videoId?: string; levels?: unknown; isFreePreview?: boolean }>,
): Set<string> {
  const byLevel = new Map<string, string[]>();
  const out = new Set<string>();
  for (const item of items) {
    const videoId = String(item.videoId || '').trim();
    if (!videoId) continue;
    if (item.isFreePreview) out.add(videoId);
    for (const level of listeningVideoLevels(item)) {
      const list = byLevel.get(level) || [];
      if (!list.includes(videoId)) list.push(videoId);
      byLevel.set(level, list);
    }
  }

  for (const ids of byLevel.values()) {
    ids.slice(0, LISTENING_FREE_VIDEO_LIMIT_PER_LEVEL).forEach((id) => out.add(id));
  }
  return out;
}

function unlockedListeningVideoIdsForCurrentList(
  items: Array<{ videoId?: string; isFreePreview?: boolean }>,
): Set<string> {
  const out = new Set<string>();
  let unlockedCount = 0;
  for (const item of items) {
    const id = String(item.videoId || '').trim();
    if (!id) continue;
    if (item.isFreePreview) {
      out.add(id);
      continue;
    }
    if (unlockedCount < LISTENING_FREE_VIDEO_LIMIT_PER_LEVEL) {
      out.add(id);
      unlockedCount += 1;
    }
  }
  return out;
}

function listeningLevelSql(level: string): Prisma.Sql {
  return Prisma.sql`(
    ${level} = ANY(normalized_levels)
    OR (COALESCE(array_length(normalized_levels, 1), 0) = 0 AND ${level} = ANY(levels))
  )`;
}

async function isUnlockedListeningPreviewVideo(videoId: string, requestedLevel?: string): Promise<boolean> {
  const level = normalizeLevel(requestedLevel);
  const predicates: Prisma.Sql[] = [Prisma.sql`(duration_sec > 0 OR 'youtube-import' = ANY(tags))`];
  if (level && level !== 'all') {
    predicates.push(listeningLevelSql(level));
  }

  const rows = await prisma.$queryRaw<ListeningVideoRow[]>(
    Prisma.sql`
      SELECT
        source_id, video_id, title, duration_sec, thumbnail, levels, normalized_levels, tags,
        category_label, created_relative, views, created_at_src, updated_at_src, video_url, embed_url,
        is_free_preview
      FROM listening_video
      WHERE ${Prisma.join(predicates, ' AND ')}
      ORDER BY COALESCE(source_order, 2147483647) ASC, inserted_at ASC
    `,
  );

  const items = rows.map(mapVideo);
  const unlockedIds = level && level !== 'all'
    ? unlockedListeningVideoIdsForCurrentList(items)
    : unlockedListeningVideoIdsByLevel(items);
  return unlockedIds.has(videoId);
}

function maskListeningVideosForAccess(items: any[], isPremium: boolean, requestedLevel?: string) {
  if (isPremium) return items.map((item) => ({ ...item, isLocked: false }));
  const level = normalizeLevel(requestedLevel);
  const unlockedIds = level && level !== 'all'
    ? unlockedListeningVideoIdsForCurrentList(items)
    : unlockedListeningVideoIdsByLevel(items);
  return items.map((item) => {
    const videoId = String(item.videoId || '').trim();
    if (unlockedIds.has(videoId)) return { ...item, isLocked: false };
    return maskLockedListeningVideo(item);
  });
}

function maskLockedListeningVideo(item: any) {
  const out: Record<string, any> = {};
  for (const field of listeningVideoMaskRule.keepFields) {
    const key = String(field);
    if (key in item) out[key] = item[key];
  }
  for (const field of listeningVideoMaskRule.maskFields || []) {
    out[String(field)] = null;
  }
  out.isFreePreview = false;
  out.is_free_preview = false;
  out.isLocked = true;
  out.lockReason = listeningVideoMaskRule.marker || 'PREMIUM_REQUIRED';
  return out;
}


function extractYoutubeVideoId(input: unknown): string {
  const raw = String(input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const candidate = url.pathname.split('/').filter(Boolean)[0] || '';
      return /^[a-zA-Z0-9_-]{11}$/.test(candidate) ? candidate : '';
    }
    if (host.endsWith('youtube.com')) {
      const watchId = url.searchParams.get('v') || '';
      if (/^[a-zA-Z0-9_-]{11}$/.test(watchId)) return watchId;
      const parts = url.pathname.split('/').filter(Boolean);
      const markerIndex = parts.findIndex((part) => ['embed', 'shorts', 'live'].includes(part));
      const candidate = markerIndex >= 0 ? parts[markerIndex + 1] || '' : '';
      return /^[a-zA-Z0-9_-]{11}$/.test(candidate) ? candidate : '';
    }
  } catch {
    return '';
  }
  return '';
}

function normalizeManualTranscriptLines(input: unknown): YoutubeTranscriptLine[] {
  const rawItems = Array.isArray(input)
    ? input
    : String(input || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

  const lines: YoutubeTranscriptLine[] = [];
  for (const item of rawItems) {
    const text = String(typeof item === 'string' ? item : (item as any)?.text || '').trim();
    if (!text) continue;
    const start = Number((item as any)?.start);
    const end = Number((item as any)?.end);
    const dur = Number((item as any)?.dur);
    lines.push({
      text,
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(end) ? end : null,
      dur: Number.isFinite(dur) ? dur : null,
    });
  }
  return lines.slice(0, 2000);
}

function decodeHtmlEntities(input: unknown): string {
  return String(input || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)));
}

function stripHtml(input: unknown): string {
  return decodeHtmlEntities(String(input || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJsonObjectAfter(html: string, marker: string): unknown {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = html.indexOf('{', markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function pickYoutubeCaptionTrack(playerResponse: any): { baseUrl: string; languageCode: string; kind: string } | null {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || !tracks.length) return null;

  const normalized = tracks.map((track: any) => ({
    baseUrl: String(track?.baseUrl || ''),
    languageCode: String(track?.languageCode || '').toLowerCase(),
    kind: String(track?.kind || '').toLowerCase(),
    name: String(track?.name?.simpleText || track?.name?.runs?.[0]?.text || '').toLowerCase(),
  })).filter((track) => track.baseUrl);

  return (
    normalized.find((track) => track.languageCode === 'ja' && track.kind !== 'asr') ||
    normalized.find((track) => track.languageCode.startsWith('ja')) ||
    normalized.find((track) => track.languageCode === 'ja' && track.kind === 'asr') ||
    normalized.find((track) => track.name.includes('japanese') || track.name.includes('日本')) ||
    null
  );
}

function parseYoutubeTranscriptXml(xml: string): YoutubeTranscriptLine[] {
  const lines: YoutubeTranscriptLine[] = [];
  const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let match = textRegex.exec(xml);
  while (match) {
    const attrs = match[1] || '';
    const rawText = match[2] || '';
    const startMatch = attrs.match(/\bstart="([^"]+)"/);
    const durMatch = attrs.match(/\bdur="([^"]+)"/);
    const start = startMatch ? Number(startMatch[1]) : null;
    const dur = durMatch ? Number(durMatch[1]) : null;
    const text = stripHtml(rawText);
    if (text) {
      const safeStart = Number.isFinite(start) ? Number(start) : null;
      const safeDur = Number.isFinite(dur) ? Number(dur) : null;
      lines.push({
        text,
        start: safeStart,
        dur: safeDur,
        end: safeStart !== null && safeDur !== null ? safeStart + safeDur : null,
      });
    }
    match = textRegex.exec(xml);
  }
  if (lines.length > 0) return lines;

  const paragraphRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  match = paragraphRegex.exec(xml);
  while (match) {
    const attrs = match[1] || '';
    const rawText = match[2] || '';
    const startMatch = attrs.match(/\bt="([^"]+)"/);
    const durMatch = attrs.match(/\bd="([^"]+)"/);
    const startMs = startMatch ? Number(startMatch[1]) : null;
    const durMs = durMatch ? Number(durMatch[1]) : null;
    const text = stripHtml(rawText.replace(/<\/s>\s*<s\b[^>]*>/g, ' '));
    if (text) {
      const safeStart = Number.isFinite(startMs) ? Number(startMs) / 1000 : null;
      const safeDur = Number.isFinite(durMs) ? Number(durMs) / 1000 : null;
      lines.push({
        text,
        start: safeStart,
        dur: safeDur,
        end: safeStart !== null && safeDur !== null ? safeStart + safeDur : null,
      });
    }
    match = paragraphRegex.exec(xml);
  }
  return lines;
}

function parseYoutubeTranscriptJson3(jsonText: string): YoutubeTranscriptLine[] {
  const payload = JSON.parse(jsonText) as any;
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const lines: YoutubeTranscriptLine[] = [];
  for (const event of events) {
    const segs = Array.isArray(event?.segs) ? event.segs : [];
    const text = segs
      .map((seg: any) => String(seg?.utf8 || ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const startMs = Number(event?.tStartMs);
    const durMs = Number(event?.dDurationMs);
    const start = Number.isFinite(startMs) ? startMs / 1000 : null;
    const dur = Number.isFinite(durMs) ? durMs / 1000 : null;
    lines.push({
      text,
      start,
      dur,
      end: start !== null && dur !== null ? start + dur : null,
    });
  }
  return normalizeTranscriptLineTiming(lines);
}

function normalizeTranscriptLineTiming(lines: YoutubeTranscriptLine[]): YoutubeTranscriptLine[] {
  const sorted = lines
    .filter((line) => String(line.text || '').trim())
    .sort((a, b) => Number(a.start ?? 0) - Number(b.start ?? 0));

  return sorted.map((line, index) => {
    const start = line.start;
    const nextStart = sorted[index + 1]?.start ?? null;
    let end = line.end;
    if (start !== null && nextStart !== null && nextStart > start) {
      end = end === null ? nextStart : Math.min(end, nextStart);
    }
    const dur = start !== null && end !== null ? Math.max(0, end - start) : line.dur;
    return { ...line, end, dur };
  });
}

async function fetchYoutubeCaptionLines(baseUrl: string): Promise<{ lines: YoutubeTranscriptLine[]; format: string }> {
  const separator = baseUrl.includes('?') ? '&' : '?';
  const attempts = [
    { url: `${baseUrl}${separator}fmt=json3`, format: 'json3' },
    { url: baseUrl, format: 'xml' },
    { url: `${baseUrl}${separator}fmt=srv3`, format: 'srv3' },
  ];

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const body = await fetchTextWithTimeout(attempt.url);
      const lines = attempt.format === 'json3'
        ? parseYoutubeTranscriptJson3(body)
        : parseYoutubeTranscriptXml(body);
      if (lines.length > 0) {
        return { lines, format: attempt.format };
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return { lines: [], format: 'none' };
}

async function fetchYoutubeCaptionLinesWithYtDlp(videoId: string): Promise<YoutubeTranscriptLine[]> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'listening-youtube-subs-'));
  try {
    await youtubeDl.exec(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        skipDownload: true,
        writeSub: true,
        writeAutoSub: true,
        subLang: 'ja',
        subFormat: 'json3',
        output: path.join(tempDir, '%(id)s.%(ext)s'),
        noPlaylist: true,
        noWarnings: true,
        quiet: true,
      },
      { timeout: 2 * 60 * 1000 },
    );

    const files = await readdir(tempDir);
    const json3File = files.find((file) => file.endsWith('.ja.json3')) || files.find((file) => file.endsWith('.json3'));
    if (!json3File) return [];
    const body = await readFile(path.join(tempDir, json3File), 'utf8');
    return parseYoutubeTranscriptJson3(body);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function mapOpenAiTranscriptionToLines(payload: any): YoutubeTranscriptLine[] {
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  const lines: YoutubeTranscriptLine[] = [];
  for (const segment of segments) {
    const text = String(segment?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const safeStart = Number.isFinite(start) ? start : null;
    const safeEnd = Number.isFinite(end) ? end : null;
    lines.push({
      text,
      start: safeStart,
      end: safeEnd,
      dur: safeStart !== null && safeEnd !== null ? Math.max(0, safeEnd - safeStart) : null,
    });
  }

  if (lines.length > 0) return lines;
  return normalizeManualTranscriptLines(String(payload?.text || ''));
}

async function downloadYoutubeAudioBuffer(videoId: string): Promise<Buffer> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'listening-youtube-'));
  const outputPath = path.join(tempDir, `${videoId}.webm`);
  try {
    await youtubeDl.exec(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        format: 'bestaudio[ext=webm]/bestaudio/best',
        output: outputPath,
        noPlaylist: true,
        noWarnings: true,
        quiet: true,
        forceOverwrites: true,
        addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
      },
      { timeout: 5 * 60 * 1000 },
    );

    const info = await stat(outputPath);
    if (info.size > LISTENING_AI_TRANSCRIPT_MAX_AUDIO_BYTES) {
      throw new Error('Audio file is too large for transcription.');
    }
    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function transcribeYoutubeAudioWithOpenAi(videoId: string, durationSec: number): Promise<YoutubeTranscriptLine[]> {
  if (!LISTENING_AI_TRANSCRIPT_ENABLED) {
    throw new Error('AI transcript is disabled.');
  }
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }
  if (durationSec > LISTENING_AI_TRANSCRIPT_MAX_DURATION_SEC) {
    throw new Error('Video is too long for synchronous AI transcript generation.');
  }

  const audio = await downloadYoutubeAudioBuffer(videoId);
  if (!audio.length) {
    throw new Error('Downloaded audio is empty.');
  }

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/webm' }), `${videoId}.webm`);
  form.append('model', LISTENING_AI_TRANSCRIPT_MODEL || 'whisper-1');
  form.append('language', LISTENING_AI_TRANSCRIPT_LANGUAGE || 'ja');
  form.append('response_format', 'verbose_json');
  if ((LISTENING_AI_TRANSCRIPT_MODEL || 'whisper-1') === 'whisper-1') {
    form.append('timestamp_granularities[]', 'segment');
  }

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI transcription failed: HTTP ${response.status} ${detail.slice(0, 300)}`);
  }

  const payload = await response.json();
  return mapOpenAiTranscriptionToLines(payload);
}

async function fetchTextWithTimeout(url: string, timeoutMs = 15000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
        'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYoutubeImportData(videoId: string, options: YoutubeImportOptions = {}): Promise<YoutubeImportResult> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=ja`;
  const html = await fetchTextWithTimeout(watchUrl);
  const playerResponse = extractJsonObjectAfter(html, 'ytInitialPlayerResponse') as any;
  const videoDetails = playerResponse?.videoDetails || {};
  const title = stripHtml(videoDetails.title || '') || `YouTube ${videoId}`;
  const durationSec = Math.max(0, Number(videoDetails.lengthSeconds || 0));
  const views = Math.max(0, Number(videoDetails.viewCount || 0));
  const thumbnails = Array.isArray(videoDetails.thumbnail?.thumbnails) ? videoDetails.thumbnail.thumbnails : [];
  const thumbnail =
    String(thumbnails[thumbnails.length - 1]?.url || '').trim() ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const track = pickYoutubeCaptionTrack(playerResponse);
  let lines: YoutubeTranscriptLine[] = [];
  let transcriptSource = 'none';
  if (track?.baseUrl) {
    try {
      const result = await fetchYoutubeCaptionLines(track.baseUrl);
      lines = result.lines;
      const sourceKind = track.kind === 'asr' ? 'youtube-auto-caption' : 'youtube-caption';
      transcriptSource = `${sourceKind}:${track.languageCode}:${result.format}`;
    } catch {
      lines = [];
      transcriptSource = 'caption-fetch-failed';
    }
  }
  if (lines.length === 0) {
    try {
      lines = await fetchYoutubeCaptionLinesWithYtDlp(videoId);
      if (lines.length > 0) {
        transcriptSource = 'youtube-auto-caption:ja:yt-dlp-json3';
      }
    } catch (error) {
      console.warn('Cannot fetch YouTube subtitles with yt-dlp', {
        videoId,
        message: error instanceof Error ? error.message : String(error),
      });
      transcriptSource = transcriptSource === 'none'
        ? 'yt-dlp-caption-failed'
        : `${transcriptSource};yt-dlp-caption-failed`;
    }
  }
  if (lines.length === 0 && options.allowAiTranscript) {
    try {
      lines = await transcribeYoutubeAudioWithOpenAi(videoId, durationSec);
      transcriptSource = lines.length > 0 ? `openai-transcribe:${LISTENING_AI_TRANSCRIPT_MODEL || 'whisper-1'}` : 'openai-transcribe-empty';
    } catch (error) {
      console.warn('Cannot generate AI transcript for YouTube video', {
        videoId,
        message: error instanceof Error ? error.message : String(error),
      });
      transcriptSource = transcriptSource === 'none'
        ? 'ai-transcript-failed'
        : `${transcriptSource};ai-transcript-failed`;
    }
  }

  return {
    videoId,
    title,
    durationSec,
    thumbnail,
    views,
    lines,
    transcriptSource,
  };
}

async function saveImportedYoutubeVideo(importData: YoutubeImportResult) {
  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO listening_video (
        source_id, video_id, title, duration_sec, thumbnail, levels, normalized_levels, tags,
        category_label, created_relative, views, created_at_src, updated_at_src, video_url, embed_url, updated_at
      ) VALUES (
        ${`youtube-import-${importData.videoId}`}, ${importData.videoId}, ${importData.title}, ${importData.durationSec},
        ${importData.thumbnail}, ${[]}, ${[]}, ${['youtube-import']}, ${'YouTube'}, ${'Imported'}, ${BigInt(importData.views || 0)},
        ${null}, ${null}, ${`https://www.youtube.com/watch?v=${importData.videoId}`},
        ${`https://www.youtube.com/embed/${importData.videoId}`}, NOW()
      )
      ON CONFLICT (video_id) DO UPDATE SET
        source_id = COALESCE(listening_video.source_id, EXCLUDED.source_id),
        title = EXCLUDED.title,
        duration_sec = EXCLUDED.duration_sec,
        thumbnail = EXCLUDED.thumbnail,
        tags = CASE
          WHEN NOT ('youtube-import' = ANY(listening_video.tags)) THEN array_append(listening_video.tags, 'youtube-import')
          ELSE listening_video.tags
        END,
        category_label = COALESCE(listening_video.category_label, EXCLUDED.category_label),
        views = EXCLUDED.views,
        video_url = EXCLUDED.video_url,
        embed_url = EXCLUDED.embed_url,
        updated_at = NOW()
    `,
  );

  if (importData.lines.length > 0) {
    await replaceListeningTranscript(importData.videoId, importData.lines);
  }
}

async function replaceListeningTranscript(videoId: string, lines: YoutubeTranscriptLine[]) {
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM listening_transcript_line WHERE video_id = ${videoId}`,
  );
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const startSec = Number.isFinite(line.start) ? Number(line.start) : null;
    const endSec = Number.isFinite(line.end) ? Number(line.end) : null;
    const durSec = Number.isFinite(line.dur) ? Number(line.dur) : null;
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO listening_transcript_line (
          video_id, line_index, text, start_sec, end_sec, dur_sec, ruby_html
        ) VALUES (
          ${videoId}, ${index}, ${line.text},
          ${startSec},
          ${endSec},
          ${durSec},
          ${null}
        )
      `,
    );
  }
}

function rememberTranslation(cacheKey: string, translation: string) {
  if (translationCache.size >= MAX_TRANSLATION_CACHE_SIZE) {
    const oldestKey = translationCache.keys().next().value;
    if (oldestKey) translationCache.delete(oldestKey);
  }
  translationCache.set(cacheKey, translation);
}

async function translateWithApiKey(text: string, targetLanguage: string, apiKey: string): Promise<string> {
  const params = new URLSearchParams({
    'params.client': 'gtx',
    'query.source_language': 'ja',
    'query.target_language': targetLanguage,
    'query.display_language': 'en-US',
    'query.text': text,
    key: apiKey,
  });
  params.append('data_types', 'TRANSLATION');
  params.append('data_types', 'SENTENCE_SPLITS');
  params.append('data_types', 'BILINGUAL_DICTIONARY_FULL');

  const response = await fetch(`https://translate-pa.googleapis.com/v1/translate?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`translate-pa failed: ${response.status}`);
  }

  const payload = (await response.json()) as { translation?: unknown };
  return String(payload?.translation || '').trim();
}

async function translateWithPublicEndpoint(text: string, targetLanguage: string): Promise<string> {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'ja',
    tl: targetLanguage,
    dt: 't',
    q: text,
  });
  const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`translate.googleapis.com failed: ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  const segments = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : [];
  return segments
    .map((item) => (Array.isArray(item) ? String(item[0] || '') : ''))
    .join('')
    .trim();
}

function normalizeVideoIdForTranslation(input: unknown): string {
  const value = String(input || '').trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(value) ? value : '';
}

function normalizeLineIndexForTranslation(input: unknown): number | null {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function normalizeLookupText(input: unknown): string {
  return String(input || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LISTENING_VOCAB_LOOKUP_MAX_TEXT_LENGTH);
}

function normalizeLookupQuery(input: string) {
  return String(input || '')
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .trim();
}

function katakanaToHiragana(input: string) {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0x30a1 && code <= 0x30f6) {
      out += String.fromCharCode(code - 0x60);
    } else {
      out += input[i];
    }
  }
  return out;
}

function isJapaneseContentToken(surface: string) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(surface);
}

function mapLookupWord(row: ListeningVocabLookupRow) {
  return {
    id: `vocab:${Number(row.id)}`,
    wordJa: String(row.word_ja || '').trim(),
    reading: String(row.word_hira_kana || '').trim(),
    romaji: String(row.word_romaji || '').trim(),
    meaningVi: String(row.word_vi || '').trim(),
    audioUrl: String(row.audio_url || '').trim(),
    level: String(row.level || '').trim(),
    topic: String(row.topic || '').trim(),
    source: 'vocabulary',
  };
}

function mapCorodomoLookupWord(row: ListeningCorodomoVocabLookupRow) {
  const text = String(row.text || '').trim();
  return {
    id: `corodomo:${Number(row.id)}`,
    wordJa: text,
    reading: '',
    romaji: '',
    meaningVi: String(row.translation || '').trim(),
    audioUrl: '',
    level: String(row.level || '').trim(),
    topic: String(row.pos || 'corodomo').trim(),
    source: 'corodomo',
  };
}

function parseCookieHeaderFromStorageState(input: unknown) {
  const cookies = Array.isArray((input as any)?.cookies) ? (input as any).cookies : [];
  return cookies
    .filter((cookie: any) => String(cookie?.domain || '').includes('corodomo.com'))
    .map((cookie: any) => `${String(cookie?.name || '')}=${String(cookie?.value || '')}`)
    .filter((item: string) => item && !item.startsWith('='))
    .join('; ');
}

async function readCorodomoCookieHeader() {
  const candidates = [
    process.env.CORODOMO_SESSION_PATH,
    path.resolve(process.cwd(), '..', 'vocab-frontend', '.corodomo', 'storageState.json'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const payload = JSON.parse(await readFile(candidate, 'utf8'));
      const cookieHeader = parseCookieHeaderFromStorageState(payload);
      if (cookieHeader) return cookieHeader;
    } catch {
      // Ignore invalid or unavailable local browser session state.
    }
  }
  return '';
}

const CORODOMO_AI_LOOKUP_CONCURRENCY = 4;

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function next(): Promise<void> {
    const current = cursor++;
    if (current >= items.length) return;
    await worker(items[current]);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => next()));
}

async function fetchCorodomoAiVocabulary(term: string) {
  const query = normalizeLookupQuery(term);
  if (!query || !isJapaneseContentToken(query)) return [];
  const params = new URLSearchParams({
    q: query,
    limit: '10',
    targetLang: 'vi',
    sourceLang: 'ja',
  });
  const cookie = await readCorodomoCookieHeader();
  const response = await fetch(`https://corodomo.com/api/ai/vocabulary-lookup?${params.toString()}`, {
    headers: {
      accept: 'application/json',
      referer: 'https://corodomo.com/videos',
      'user-agent': 'Mozilla/5.0',
      ...(cookie ? { cookie } : {}),
    },
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as any;
  return (Array.isArray(payload?.data) ? payload.data : [])
    .map((item: any) => ({
      text: normalizeLookupQuery(String(item?.text || '')),
      lang: String(item?.lang || 'ja').trim().toLowerCase(),
      translation: String(item?.translation || '').trim(),
    }))
    .filter((item: any) => item.text && item.translation && item.lang === 'ja');
}

async function cacheCorodomoAiVocabulary(term: string) {
  const items = await fetchCorodomoAiVocabulary(term);
  for (const item of items) {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO listening_corodomo_vocabulary (
          text, lang, target_lang, translation, pos, level, source_query, created_at, updated_at
        )
        VALUES (
          ${item.text}, ${item.lang}, 'vi', ${item.translation}, 'corodomo-ai', '', ${normalizeLookupQuery(term)}, NOW(), NOW()
        )
        ON CONFLICT (text, lang, target_lang)
        DO UPDATE SET
          translation = EXCLUDED.translation,
          pos = COALESCE(NULLIF(listening_corodomo_vocabulary.pos, ''), EXCLUDED.pos),
          source_query = EXCLUDED.source_query,
          updated_at = NOW()
      `,
    );
  }
  return items;
}

function buildTokenNgrams(tokens: ListeningVocabLookupToken[]) {
  const ngrams = new Set<string>();
  for (let start = 0; start < tokens.length; start += 1) {
    let surface = '';
    let reading = '';
    for (let end = start; end < Math.min(tokens.length, start + LISTENING_VOCAB_LOOKUP_MAX_NGRAM); end += 1) {
      const token = tokens[end];
      if (!isJapaneseContentToken(token.surface)) break;
      surface += token.surface;
      reading += token.reading || '';
      if (surface.length > 1) ngrams.add(surface);
      if (reading.length > 1) ngrams.add(reading);
    }
  }
  return Array.from(ngrams);
}

function pickBestLookupSpan(
  tokens: ListeningVocabLookupToken[],
  start: number,
  wordsByKey: Map<string, ListeningVocabLookupWord[]>,
) {
  let best: {
    end: number;
    surface: string;
    reading: string;
    words: ListeningVocabLookupWord[];
  } | null = null;

  let surface = '';
  let reading = '';
  for (let end = start; end < Math.min(tokens.length, start + LISTENING_VOCAB_LOOKUP_MAX_NGRAM); end += 1) {
    const token = tokens[end];
    if (!isJapaneseContentToken(token.surface)) break;
    surface += token.surface;
    reading += token.reading || '';
    const keys = [surface, reading].filter(Boolean);
    const words = keys.flatMap((key) => wordsByKey.get(key) || []);
    const uniqueWords = Array.from(new Map(words.map((word) => [word.id, word])).values());
    if (uniqueWords.length > 0) {
      best = {
        end,
        surface,
        reading,
        words: uniqueWords.slice(0, 5),
      };
    }
  }

  return best;
}

const NUMBER_COUNTER_SUFFIXES = new Set([
  '\u6642',
  '\u5206',
  '\u79d2',
  '\u5186',
  '\u4eba',
  '\u540d',
  '\u6b73',
  '\u624d',
  '\u5e74',
  '\u6708',
  '\u65e5',
  '\u500b',
  '\u672c',
  '\u679a',
  '\u56de',
  '\u968e',
  '\u676f',
  '\u5339',
  '\u982d',
]);

function tokenReading(token: ListeningVocabLookupToken) {
  return token.reading || token.surface;
}

function isNumberToken(token: ListeningVocabLookupToken) {
  return token.posDetail === '数' || /^[0-9０-９一二三四五六七八九十百千万億兆]+$/u.test(token.surface);
}

function isCounterSuffixToken(token: ListeningVocabLookupToken | undefined) {
  return Boolean(token) && NUMBER_COUNTER_SUFFIXES.has(token!.surface);
}

function isInflectableToken(token: ListeningVocabLookupToken) {
  return token.pos === '動詞' || token.pos === '形容詞';
}

function isAuxiliaryToken(token: ListeningVocabLookupToken | undefined) {
  return Boolean(token) && token!.pos === '助動詞';
}

function collectLookupWords(keys: string[], wordsByKey: Map<string, ListeningVocabLookupWord[]>) {
  const words = keys.flatMap((key) => wordsByKey.get(key) || []);
  return Array.from(new Map(words.map((word) => [word.id, word])).values()).slice(0, 5);
}

function buildLookupKeysForSpan(tokens: ListeningVocabLookupToken[], surface: string, reading: string) {
  const keys = new Set<string>([surface, reading].filter(Boolean));
  const normalizedSurface = normalizeLookupQuery(surface);
  if (normalizedSurface) keys.add(normalizedSurface);
  for (const token of tokens) {
    [token.surface, token.basic, token.reading].filter(Boolean).forEach((key) => keys.add(key));
    const normalizedTokenSurface = normalizeLookupQuery(token.surface);
    if (normalizedTokenSurface) keys.add(normalizedTokenSurface);
  }
  return Array.from(keys);
}

function pickDisplaySpan(tokens: ListeningVocabLookupToken[], start: number) {
  const first = tokens[start];
  if (!first) return null;

  if (isNumberToken(first) && isCounterSuffixToken(tokens[start + 1])) {
    const spanTokens = tokens.slice(start, start + 2);
    return {
      end: start + 1,
      surface: spanTokens.map((token) => token.surface).join(''),
      reading: spanTokens.map(tokenReading).join(''),
      pos: 'counter',
      posDetail: '',
      tokens: spanTokens,
    };
  }

  if (!isJapaneseContentToken(first.surface)) return null;

  if (isInflectableToken(first) && isAuxiliaryToken(tokens[start + 1])) {
    let end = start + 1;
    while (end + 1 < tokens.length && isAuxiliaryToken(tokens[end + 1])) {
      end += 1;
    }
    const spanTokens = tokens.slice(start, end + 1);
    return {
      end,
      surface: spanTokens.map((token) => token.surface).join(''),
      reading: spanTokens.map(tokenReading).join(''),
      pos: first.pos,
      posDetail: first.posDetail,
      tokens: spanTokens,
    };
  }

  return null;
}

function compactLookupTokens(
  tokens: ListeningVocabLookupToken[],
  wordsByKey: Map<string, ListeningVocabLookupWord[]>,
) {
  const out = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const displaySpan = pickDisplaySpan(tokens, index);
    if (displaySpan) {
      const words = collectLookupWords(
        buildLookupKeysForSpan(displaySpan.tokens, displaySpan.surface, displaySpan.reading),
        wordsByKey,
      );
      out.push({
        surface: displaySpan.surface,
        basic: '',
        reading: displaySpan.reading,
        pos: displaySpan.pos,
        posDetail: displaySpan.posDetail,
        words,
      });
      index = displaySpan.end;
      continue;
    }

    const token = tokens[index];
    const lookupKeys = [token.surface, token.basic, token.reading].filter(Boolean);
    const span = pickBestLookupSpan(tokens, index, wordsByKey);
    const shouldUsePhraseSpan =
      span &&
      span.end > index &&
      !tokens.slice(index, span.end + 1).some((item, itemIndex) => itemIndex > 0 && item.pos === '助詞');
    if (shouldUsePhraseSpan) {
      out.push({
        surface: span.surface,
        basic: '',
        reading: span.reading,
        pos: 'phrase',
        posDetail: '',
        words: span.words,
      });
      index = span.end;
      continue;
    }

    const uniqueWords = collectLookupWords(lookupKeys, wordsByKey);
    out.push({
      ...token,
      words: uniqueWords,
    });
  }
  return out;
}

async function ensureListeningCorodomoVocabularyTable() {
  if (!ensureListeningCorodomoVocabularyTablePromise) {
    ensureListeningCorodomoVocabularyTablePromise = (async () => {
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
    })().catch((error) => {
      ensureListeningCorodomoVocabularyTablePromise = null;
      throw error;
    });
  }
  return ensureListeningCorodomoVocabularyTablePromise;
}

async function ensureListeningSummaryTable() {
  if (!ensureListeningSummaryTablePromise) {
    ensureListeningSummaryTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS listening_video_summary (
          id BIGSERIAL PRIMARY KEY,
          video_id VARCHAR(20) NOT NULL,
          language VARCHAR(10) NOT NULL,
          summary TEXT NOT NULL,
          key_points TEXT[] NOT NULL DEFAULT '{}',
          model VARCHAR(100),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT listening_video_summary_video_fk
            FOREIGN KEY (video_id) REFERENCES listening_video(video_id) ON DELETE CASCADE,
          CONSTRAINT listening_video_summary_video_lang_uniq
            UNIQUE(video_id, language)
        );
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE listening_video_summary
        ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'ai';
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE listening_video_summary
        ADD COLUMN IF NOT EXISTS format VARCHAR(20) NOT NULL DEFAULT 'text';
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE listening_video_summary
        ADD COLUMN IF NOT EXISTS key_vocabulary JSONB NOT NULL DEFAULT '[]';
      `);
    })().catch((error) => {
      ensureListeningSummaryTablePromise = null;
      throw error;
    });
  }
  return ensureListeningSummaryTablePromise;
}

type StoredSummaryRow = {
  summary: string;
  key_points: string[];
  model: string | null;
  source: string;
  format: string;
  key_vocabulary: unknown;
};

async function readStoredSummary(videoId: string, language: string): Promise<StoredSummaryRow | null> {
  await ensureListeningSummaryTable();
  const rows = await prisma.$queryRaw<StoredSummaryRow[]>(
    Prisma.sql`
      SELECT summary, key_points, model, source, format, key_vocabulary
      FROM listening_video_summary
      WHERE video_id = ${videoId} AND language = ${language}
      LIMIT 1
    `,
  );
  return rows[0] || null;
}

async function saveStoredSummary(
  videoId: string,
  language: string,
  summary: string,
  keyPoints: string[],
  model: string,
  source: string,
  format: string,
  keyVocabulary: unknown[],
): Promise<void> {
  await ensureListeningSummaryTable();
  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO listening_video_summary (
        video_id, language, summary, key_points, model, source, format, key_vocabulary, created_at, updated_at
      )
      VALUES (
        ${videoId}, ${language}, ${summary}, ${keyPoints}, ${model}, ${source}, ${format},
        ${JSON.stringify(keyVocabulary)}::jsonb, NOW(), NOW()
      )
      ON CONFLICT (video_id, language)
      DO UPDATE SET
        summary = EXCLUDED.summary,
        key_points = EXCLUDED.key_points,
        model = EXCLUDED.model,
        source = EXCLUDED.source,
        format = EXCLUDED.format,
        key_vocabulary = EXCLUDED.key_vocabulary,
        updated_at = NOW()
    `,
  );
}

async function resolveCorodomoVideoCuid(videoId: string): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ source_id: string | null }>>(
    Prisma.sql`SELECT source_id FROM listening_video WHERE video_id = ${videoId} LIMIT 1`,
  );
  const raw = String(rows[0]?.source_id || '').replace(/^crawl-/, '').trim();
  return /^cm[a-z0-9]+$/i.test(raw) ? raw : '';
}

async function fetchCorodomoVideoSummary(
  corodomoCuid: string,
  language: string,
): Promise<{ summary: string; keyVocabulary: unknown[] } | null> {
  try {
    const cookie = await readCorodomoCookieHeader();
    const response = await fetch(
      `https://corodomo.com/api/v1/videos/${encodeURIComponent(corodomoCuid)}/summary?lang=${encodeURIComponent(language)}`,
      {
        headers: {
          accept: 'application/json',
          referer: 'https://corodomo.com/videos',
          'user-agent': 'Mozilla/5.0',
          ...(cookie ? { cookie } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { data?: { data?: unknown; keyVocabulary?: unknown } };
    const markdown = String(payload?.data?.data || '').trim();
    if (!markdown) return null;
    const keyVocabulary = Array.isArray(payload?.data?.keyVocabulary) ? payload.data.keyVocabulary : [];
    return { summary: markdown, keyVocabulary };
  } catch {
    return null;
  }
}

const SUMMARY_LANGUAGE_NAMES: Record<string, string> = {
  vi: 'Vietnamese',
  en: 'English',
  ja: 'Japanese',
};

async function generateListeningSummary(
  transcriptText: string,
  language: string,
): Promise<{ summary: string; keyPoints: string[]; model: string }> {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY is not configured') as Error & { status?: number };
    error.status = 500;
    throw error;
  }
  const model = process.env.OPENAI_LISTENING_SUMMARY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const languageName = SUMMARY_LANGUAGE_NAMES[language] || 'Vietnamese';

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Ban la giao vien tieng Nhat. Tom tat noi dung video luyen nghe cho hoc vien JLPT. ' +
            `Tra loi bang tieng ${languageName}, ro rang, ngan gon, dung dinh dang JSON { "summary": string, "keyPoints": string[] }. ` +
            'summary la doan tom tat 3-5 cau. keyPoints la 3-6 y chinh, moi y mot cau ngan.',
        },
        {
          role: 'user',
          content: `Day la phu de day du cua video (tieng Nhat):\n\n${transcriptText.slice(0, 12000)}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`OpenAI request failed (${response.status}): ${detail}`) as Error & { status?: number };
    error.status = 502;
    throw error;
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const rawContent = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!rawContent) {
    const error = new Error('OpenAI returned empty summary') as Error & { status?: number };
    error.status = 502;
    throw error;
  }

  let parsed: { summary?: unknown; keyPoints?: unknown };
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    const error = new Error('OpenAI returned invalid summary JSON') as Error & { status?: number };
    error.status = 502;
    throw error;
  }

  const summary = String(parsed?.summary || '').trim();
  const keyPoints = Array.isArray(parsed?.keyPoints)
    ? parsed.keyPoints.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  if (!summary) {
    const error = new Error('OpenAI returned empty summary') as Error & { status?: number };
    error.status = 502;
    throw error;
  }

  return { summary, keyPoints, model };
}

async function ensureListeningTranslationTable() {
  if (!ensureListeningTranslationTablePromise) {
    ensureListeningTranslationTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS listening_transcript_translation (
          id BIGSERIAL PRIMARY KEY,
          video_id VARCHAR(20) NOT NULL,
          line_index INTEGER NOT NULL,
          language VARCHAR(10) NOT NULL,
          source_text TEXT NOT NULL,
          translation TEXT NOT NULL,
          provider VARCHAR(50) NOT NULL DEFAULT 'google',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT listening_transcript_translation_video_fk
            FOREIGN KEY (video_id) REFERENCES listening_video(video_id) ON DELETE CASCADE,
          CONSTRAINT listening_transcript_translation_line_lang_uniq
            UNIQUE(video_id, line_index, language)
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_listening_transcript_translation_lookup
        ON listening_transcript_translation (video_id, line_index, language);
      `);
    })().catch((error) => {
      ensureListeningTranslationTablePromise = null;
      throw error;
    });
  }
  return ensureListeningTranslationTablePromise;
}

async function readStoredTranslation(
  videoId: string,
  lineIndex: number,
  language: string,
  sourceText: string,
): Promise<string> {
  await ensureListeningTranslationTable();
  const rows = await prisma.$queryRaw<StoredTranslationRow[]>(
    Prisma.sql`
      SELECT translation
      FROM listening_transcript_translation
      WHERE video_id = ${videoId}
        AND line_index = ${lineIndex}
        AND language = ${language}
        AND source_text = ${sourceText}
      LIMIT 1
    `,
  );
  return String(rows[0]?.translation || '').trim();
}

async function saveStoredTranslation(
  videoId: string,
  lineIndex: number,
  language: string,
  sourceText: string,
  translation: string,
  provider: string,
) {
  await ensureListeningTranslationTable();
  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO listening_transcript_translation (
        video_id, line_index, language, source_text, translation, provider, created_at, updated_at
      )
      VALUES (${videoId}, ${lineIndex}, ${language}, ${sourceText}, ${translation}, ${provider}, NOW(), NOW())
      ON CONFLICT (video_id, line_index, language)
      DO UPDATE SET
        source_text = EXCLUDED.source_text,
        translation = EXCLUDED.translation,
        provider = EXCLUDED.provider,
        updated_at = NOW()
    `,
  );
}

export function createListeningRouter() {
  const router = Router();

  router.post('/translate', async (req: Request, res: Response) => {
    const text = String(req.body?.text || '').trim();
    const targetLanguage = String(req.body?.targetLanguage || 'vi').trim().toLowerCase();
    const videoId = normalizeVideoIdForTranslation(req.body?.videoId);
    const lineIndex = normalizeLineIndexForTranslation(req.body?.lineIndex);
    const canPersistTranslation = Boolean(videoId && lineIndex !== null);

    if (!text) {
      return res.status(400).json({ success: false, message: 'Nội dung cần dịch không được để trống.' });
    }
    if (text.length > 1000) {
      return res.status(400).json({ success: false, message: 'Mỗi câu dịch không được vượt quá 1000 ký tự.' });
    }
    if (!SUPPORTED_TRANSLATION_LANGUAGES.has(targetLanguage)) {
      return res.status(400).json({ success: false, message: 'Ngôn ngữ đích không được hỗ trợ.' });
    }

    const cacheKey = `${targetLanguage}::${text}`;
    if (canPersistTranslation) {
      const storedTranslation = await readStoredTranslation(videoId, lineIndex as number, targetLanguage, text);
      if (storedTranslation) {
        rememberTranslation(cacheKey, storedTranslation);
        return res.json({ success: true, translation: storedTranslation, cached: true, source: 'database' });
      }
    }

    const cached = translationCache.get(cacheKey);
    if (cached) {
      if (canPersistTranslation) {
        await saveStoredTranslation(videoId, lineIndex as number, targetLanguage, text, cached, 'memory-cache');
      }
      return res.json({ success: true, translation: cached, cached: true, source: 'memory' });
    }

    {
      try {
        const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
        let translation = '';
        let provider = 'google-public';
        if (apiKey) {
          try {
            translation = await translateWithApiKey(text, targetLanguage, apiKey);
            provider = 'google-translate-pa';
          } catch {
            translation = '';
          }
        }
        if (!translation) {
          translation = await translateWithPublicEndpoint(text, targetLanguage);
          provider = 'google-public';
        }
        if (!translation) {
          return res.status(502).json({
            success: false,
            code: 'TRANSLATION_EMPTY_RESPONSE',
            message: 'Dich vu khong tra ve ban dich.',
          });
        }

        rememberTranslation(cacheKey, translation);
        if (canPersistTranslation) {
          await saveStoredTranslation(videoId, lineIndex as number, targetLanguage, text, translation, provider);
        }
        return res.json({ success: true, translation, cached: false, source: provider });
      } catch {
        return res.status(502).json({
          success: false,
          code: 'TRANSLATION_PROVIDER_UNAVAILABLE',
          message: 'Khong ket noi duoc dich vu dich.',
        });
      }
    }

  });

  router.post('/vocab-lookup', async (req: Request, res: Response) => {
    try {
    const rawTexts = Array.isArray(req.body?.texts)
      ? req.body.texts
      : [req.body?.text];
    const texts: string[] = rawTexts
      .map(normalizeLookupText)
      .filter(Boolean)
      .slice(0, LISTENING_VOCAB_LOOKUP_MAX_LINES);

    if (!texts.length) {
      return res.json({ lines: {} });
    }

    const tokenizedLines: Array<{ text: string; tokens: ListeningVocabLookupToken[] }> = await Promise.all(
      texts.map(async (text) => {
        const tokens = await tokenizeJapaneseText(text);
        return {
          text,
          tokens: tokens
            .map((token) => {
              const surface = String(token.surface_form || '').trim();
              const basic = String(token.basic_form || '').trim();
              const reading = katakanaToHiragana(String(token.reading || '').trim());
              return {
                surface,
                basic: basic && basic !== '*' ? basic : '',
                reading,
                pos: String(token.pos || '').trim(),
                posDetail: String(token.pos_detail_1 || '').trim(),
              };
            })
            .filter((token) => token.surface),
        };
      }),
    );

    const candidates = new Set<string>();
    for (const line of tokenizedLines) {
      for (const token of line.tokens) {
        if (!isJapaneseContentToken(token.surface)) continue;
        candidates.add(token.surface);
        candidates.add(normalizeLookupQuery(token.surface));
        if (token.basic) candidates.add(token.basic);
        if (token.reading) candidates.add(token.reading);
      }
      for (const ngram of buildTokenNgrams(line.tokens)) {
        candidates.add(ngram);
        candidates.add(normalizeLookupQuery(ngram));
      }
    }

    let terms = Array.from(candidates).filter((term) => term.length > 0).slice(0, 1200);
    const wordsByKey = new Map<string, ListeningVocabLookupWord[]>();
    if (terms.length > 0) {
      await ensureListeningCorodomoVocabularyTable();

      const exactSpanTerms = new Set<string>();
      for (const line of tokenizedLines) {
        for (let index = 0; index < line.tokens.length; index += 1) {
          const displaySpan = pickDisplaySpan(line.tokens, index);
          if (!displaySpan) continue;
          exactSpanTerms.add(normalizeLookupQuery(displaySpan.surface));
          index = displaySpan.end;
        }
      }
      for (const term of exactSpanTerms) {
        if (term && !terms.includes(term)) terms.push(term);
      }
      terms = terms.slice(0, 1200);

      if (exactSpanTerms.size > 0) {
        const existingExactRows = await prisma.$queryRaw<Array<{ text: string | null }>>(
          Prisma.sql`
            SELECT text
            FROM listening_corodomo_vocabulary
            WHERE text IN (${Prisma.join(Array.from(exactSpanTerms))})
              AND lang = 'ja'
              AND target_lang = 'vi'
          `,
        );
        const existingExact = new Set(existingExactRows.map((row) => String(row.text || '').trim()).filter(Boolean));
        const missingTerms = Array.from(exactSpanTerms).filter((term) => !existingExact.has(term));
        await runWithConcurrency(missingTerms, CORODOMO_AI_LOOKUP_CONCURRENCY, async (term) => {
          await cacheCorodomoAiVocabulary(term).catch(() => []);
        });
      }

      const corodomoRows = await prisma.$queryRaw<ListeningCorodomoVocabLookupRow[]>(
        Prisma.sql`
          SELECT id, text, lang, translation, pos, level
          FROM listening_corodomo_vocabulary
          WHERE text IN (${Prisma.join(terms)})
            AND lang = 'ja'
            AND target_lang = 'vi'
          ORDER BY LENGTH(text) DESC, id ASC
          LIMIT 2000
        `,
      );

      for (const row of corodomoRows) {
        const word = mapCorodomoLookupWord(row);
        const list = wordsByKey.get(word.wordJa) || [];
        if (!list.some((item) => item.id === word.id)) {
          list.push(word);
          wordsByKey.set(word.wordJa, list);
        }
      }

      const rows = await prisma.$queryRaw<ListeningVocabLookupRow[]>(
        Prisma.sql`
          SELECT id, word_ja, word_hira_kana, word_romaji, word_vi, audio_url, level, topic
          FROM vocabulary
          WHERE COALESCE(word_ja, '') IN (${Prisma.join(terms)})
             OR COALESCE(word_hira_kana, '') IN (${Prisma.join(terms)})
          ORDER BY
            CASE WHEN track = 'core' THEN 0 ELSE 1 END ASC,
            COALESCE(core_order, 2147483647) ASC,
            id ASC
          LIMIT 2000
        `,
      );

      for (const row of rows) {
        const word = mapLookupWord(row);
        const keys = [
          word.wordJa,
          word.reading,
          katakanaToHiragana(word.reading),
        ].filter(Boolean);
        for (const key of keys) {
          const list = wordsByKey.get(key) || [];
          if (!list.some((item) => item.id === word.id)) {
            list.push(word);
            wordsByKey.set(key, list);
          }
        }
      }
    }

    const lines: Record<string, unknown> = {};
    for (const line of tokenizedLines) {
      lines[line.text] = compactLookupTokens(line.tokens, wordsByKey);
    }

    return res.json({ lines });
    } catch (error) {
      console.error('Cannot resolve vocab lookup', error);
      return res.status(502).json({
        success: false,
        code: 'VOCAB_LOOKUP_FAILED',
        message: 'Khong tra duoc tu vung cho cau nay. Vui long thu lai sau.',
      });
    }
  });

  router.post('/import-youtube', async (req: Request, res: Response) => {
    const access = await resolveContentAccess(req);
    if (REQUIRE_PREMIUM_FOR_YOUTUBE_IMPORT && !access.isPremium) {
      return res.status(403).json({
        success: false,
        code: 'PREMIUM_REQUIRED',
        message: 'Tinh nang dan link YouTube danh cho tai khoan Premium.',
      });
    }

    const videoId = extractYoutubeVideoId(req.body?.url || req.body?.videoId);
    if (!videoId) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_YOUTUBE_URL',
        message: 'Link YouTube khong hop le.',
      });
    }

    try {
      const importData = await fetchYoutubeImportData(videoId, { allowAiTranscript: true });
      await saveImportedYoutubeVideo(importData);
      const hasTranscript = importData.lines.length > 0;
      const generatedByAi = importData.transcriptSource.startsWith('openai-transcribe:');
      return res.status(hasTranscript ? 200 : 202).json({
        success: true,
        videoId,
        status: hasTranscript ? 'ready' : 'no_caption',
        title: importData.title,
        durationSec: importData.durationSec,
        lineCount: importData.lines.length,
        transcriptSource: importData.transcriptSource,
        redirectUrl: `/listening/${videoId}`,
        message: hasTranscript
          ? generatedByAi
            ? 'Da import video YouTube va tao transcript bang AI.'
            : 'Da import video YouTube.'
          : 'Da them video, nhung chua tao duoc transcript cho video nay.',
      });
    } catch (error) {
      console.error('Cannot import YouTube video', error);
      return res.status(502).json({
        success: false,
        code: 'YOUTUBE_IMPORT_FAILED',
        message: 'Khong import duoc video YouTube. Vui long thu lai sau.',
      });
    }
  });

  router.get('/videos', async (req: Request, res: Response) => {
    const access = await resolveContentAccess(req);
    const q = String(req.query.q || '').trim();
    const level = normalizeLevel(req.query.level);
    const limitRaw = Number(req.query.limit || 5000);
    const limit = Math.min(Math.max(limitRaw, 1), 5000);
    const predicates: Prisma.Sql[] = [];

    if (q) {
      predicates.push(
        Prisma.sql`(title ILIKE ${`%${q}%`} OR video_id ILIKE ${`%${q}%`})`,
      );
    }
    if (level && level !== 'all') {
      predicates.push(listeningLevelSql(level));
    }

    const whereSql = predicates.length
      ? Prisma.sql`WHERE ${Prisma.join(predicates, ' AND ')}`
      : Prisma.sql``;

    const rows = await prisma.$queryRaw<ListeningVideoRow[]>(
      Prisma.sql`
        SELECT
          source_id, video_id, title, duration_sec, thumbnail, levels, normalized_levels, tags,
          category_label, created_relative, views, created_at_src, updated_at_src, video_url, embed_url,
          is_free_preview
        FROM listening_video
        ${whereSql}
        ${predicates.length ? Prisma.sql`AND` : Prisma.sql`WHERE`} (duration_sec > 0 OR 'youtube-import' = ANY(tags))
        ORDER BY COALESCE(source_order, 2147483647) ASC, inserted_at ASC
        LIMIT ${limit}
      `,
    );

    const items = rows.map(mapVideo);
    return res.json({
      items: maskListeningVideosForAccess(items as any[], access.isPremium, level),
      total: items.length,
      limit,
    });
  });

  router.get('/videos/:videoId', async (req: Request, res: Response) => {
    const access = await resolveContentAccess(req);
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) {
      return res.status(400).json({ message: 'videoId is required' });
    }

    const rows = await prisma.$queryRaw<ListeningVideoRow[]>(
      Prisma.sql`
        SELECT
          source_id, video_id, title, duration_sec, thumbnail, levels, normalized_levels, tags,
          category_label, created_relative, views, created_at_src, updated_at_src, video_url, embed_url,
          is_free_preview
        FROM listening_video
        WHERE video_id = ${videoId}
        LIMIT 1
      `,
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Video not found' });
    }
    const item = mapVideo(rows[0]);
    if (!access.isPremium && !(await isUnlockedListeningPreviewVideo(videoId, String(req.query.level || '')))) {
      return res.status(403).json({
        success: false,
        code: 'PREMIUM_REQUIRED',
        item: maskLockedListeningVideo(item as any),
        message: 'Video nay danh cho thanh vien Premium.',
      });
    }
    return res.json(item);
  });

  router.post('/videos/:videoId/transcript', async (req: Request, res: Response) => {
    const access = await resolveContentAccess(req);
    if (!access.isPremium) {
      return res.status(403).json({
        success: false,
        code: 'PREMIUM_REQUIRED',
        message: 'Chi tai khoan Premium moi duoc cap nhat transcript tuy chinh.',
      });
    }

    const videoId = String(req.params.videoId || '').trim();
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ success: false, message: 'videoId is invalid' });
    }

    const videoRows = await prisma.$queryRaw<Array<{ video_id: string }>>(
      Prisma.sql`
        SELECT video_id
        FROM listening_video
        WHERE video_id = ${videoId}
        LIMIT 1
      `,
    );
    if (!videoRows.length) {
      return res.status(404).json({ success: false, message: 'Video not found' });
    }

    const lines = normalizeManualTranscriptLines(req.body?.lines ?? req.body?.text);
    if (!lines.length) {
      return res.status(400).json({
        success: false,
        code: 'EMPTY_TRANSCRIPT',
        message: 'Transcript khong duoc de trong.',
      });
    }

    await replaceListeningTranscript(videoId, lines);
    return res.json({
      success: true,
      videoId,
      lineCount: lines.length,
      lines: lines.map((line) => ({
        text: line.text,
        start: line.start,
        end: line.end,
        dur: line.dur,
        rubyHtml: '',
      })),
    });
  });

  router.get('/videos/:videoId/transcript', async (req: Request, res: Response) => {
    const access = await resolveContentAccess(req);
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) {
      return res.status(400).json({ message: 'videoId is required' });
    }

    const videoRows = await prisma.$queryRaw<Array<{ is_free_preview: boolean | null }>>(
      Prisma.sql`
        SELECT is_free_preview
        FROM listening_video
        WHERE video_id = ${videoId}
        LIMIT 1
      `,
    );
    if (!videoRows.length) {
      return res.status(404).json({ message: 'Video not found' });
    }
    if (!access.isPremium && !(await isUnlockedListeningPreviewVideo(videoId, String(req.query.level || '')))) {
      return res.status(403).json({
        success: false,
        code: 'PREMIUM_REQUIRED',
        message: 'Transcript nay danh cho thanh vien Premium.',
      });
    }

    const rows = await prisma.$queryRaw<TranscriptRow[]>(
      Prisma.sql`
        SELECT line_index, text, start_sec, end_sec, dur_sec, ruby_html
        FROM listening_transcript_line
        WHERE video_id = ${videoId}
        ORDER BY line_index ASC
      `,
    );

    await ensureListeningTranslationTable();
    const translationRows = await prisma.$queryRaw<TranscriptTranslationLineRow[]>(
      Prisma.sql`
        SELECT line_index, language, translation
        FROM listening_transcript_translation
        WHERE video_id = ${videoId}
        ORDER BY line_index ASC, language ASC
      `,
    );
    const translationsByLine = new Map<number, Record<string, string>>();
    for (const row of translationRows) {
      const language = String(row.language || '').trim().toLowerCase();
      const translation = String(row.translation || '').trim();
      if (!language || !translation) continue;
      const current = translationsByLine.get(Number(row.line_index)) || {};
      current[language] = translation;
      translationsByLine.set(Number(row.line_index), current);
    }

    const lines = rows.map((line) => {
      const correctedText = TRANSCRIPT_LINE_CORRECTIONS.get(line.text) || line.text;
      const wasCorrected = correctedText !== line.text;
      return {
        text: correctedText,
        start: line.start_sec,
        end: line.end_sec,
        dur: line.dur_sec,
        rubyHtml: wasCorrected ? COMB_HAIR_RUBY_HTML : line.ruby_html || '',
        translations: translationsByLine.get(Number(line.line_index)) || {},
      };
    });

    return res.json({ videoId, lines });
  });

  router.get('/videos/:videoId/summary', async (req: Request, res: Response) => {
    const access = await resolveContentAccess(req);
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) {
      return res.status(400).json({ success: false, message: 'videoId is required' });
    }
    const language = String(req.query.language || 'vi').trim().toLowerCase() || 'vi';

    const videoRows = await prisma.$queryRaw<Array<{ is_free_preview: boolean | null }>>(
      Prisma.sql`
        SELECT is_free_preview
        FROM listening_video
        WHERE video_id = ${videoId}
        LIMIT 1
      `,
    );
    if (!videoRows.length) {
      return res.status(404).json({ success: false, message: 'Video not found' });
    }
    if (!access.isPremium && !(await isUnlockedListeningPreviewVideo(videoId, String(req.query.level || '')))) {
      return res.status(403).json({
        success: false,
        code: 'PREMIUM_REQUIRED',
        message: 'Tom tat video nay danh cho thanh vien Premium.',
      });
    }

    try {
      const cached = await readStoredSummary(videoId, language);
      if (cached) {
        return res.json({
          success: true,
          videoId,
          language,
          summary: cached.summary,
          keyPoints: Array.isArray(cached.key_points) ? cached.key_points : [],
          keyVocabulary: Array.isArray(cached.key_vocabulary) ? cached.key_vocabulary : [],
          source: cached.source || 'ai',
          format: cached.format || 'text',
          cached: true,
        });
      }

      const corodomoCuid = await resolveCorodomoVideoCuid(videoId);
      if (corodomoCuid) {
        const corodomoSummary = await fetchCorodomoVideoSummary(corodomoCuid, language);
        if (corodomoSummary) {
          await saveStoredSummary(
            videoId,
            language,
            corodomoSummary.summary,
            [],
            'corodomo',
            'corodomo',
            'markdown',
            corodomoSummary.keyVocabulary,
          );
          return res.json({
            success: true,
            videoId,
            language,
            summary: corodomoSummary.summary,
            keyPoints: [],
            keyVocabulary: corodomoSummary.keyVocabulary,
            source: 'corodomo',
            format: 'markdown',
            cached: false,
          });
        }
      }

      const lineRows = await prisma.$queryRaw<Array<{ text: string }>>(
        Prisma.sql`
          SELECT text
          FROM listening_transcript_line
          WHERE video_id = ${videoId}
          ORDER BY line_index ASC
        `,
      );
      const transcriptText = lineRows.map((row) => row.text).join('\n').trim();
      if (!transcriptText) {
        return res.status(404).json({
          success: false,
          code: 'TRANSCRIPT_NOT_AVAILABLE',
          message: 'Video nay chua co phu de de tom tat.',
        });
      }

      const { summary, keyPoints, model } = await generateListeningSummary(transcriptText, language);
      await saveStoredSummary(videoId, language, summary, keyPoints, model, 'ai', 'text', []);
      return res.json({
        success: true,
        videoId,
        language,
        summary,
        keyPoints,
        keyVocabulary: [],
        source: 'ai',
        format: 'text',
        cached: false,
      });
    } catch (error) {
      console.error('Cannot generate listening summary', error);
      const status = (error as { status?: number })?.status || 502;
      return res.status(status).json({
        success: false,
        code: 'SUMMARY_GENERATION_FAILED',
        message: 'Khong tao duoc ban tom tat. Vui long thu lai sau.',
      });
    }
  });

  return router;
}
