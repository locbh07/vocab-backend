import { Request, Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import youtubeDl from 'youtube-dl-exec';
import { prisma } from '../lib/prisma';
import { resolveContentAccess } from '../lib/contentAccess';
import { listeningVideoMaskRule } from '../lib/contentMasking';

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
  text: string;
  start_sec: number | null;
  end_sec: number | null;
  dur_sec: number | null;
  ruby_html: string | null;
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
const TRANSCRIPT_LINE_CORRECTIONS = new Map([
  ['串で紙を溶かします', '櫛で髪をとかします'],
  ['櫛で髪を溶かします', '櫛で髪をとかします'],
]);
const COMB_HAIR_RUBY_HTML =
  '<ruby>櫛<rt>くし</rt></ruby>で<ruby>髪<rt>かみ</rt></ruby>をとかします';
let ensureListeningTranslationTablePromise: Promise<void> | null = null;

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
    const startSec = line.start === null ? null : String(line.start);
    const endSec = line.end === null ? null : String(line.end);
    const durSec = line.dur === null ? null : String(line.dur);
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO listening_transcript_line (
          video_id, line_index, text, start_sec, end_sec, dur_sec, ruby_html
        ) VALUES (
          ${videoId}, ${index}, ${line.text},
          ${startSec}::double precision,
          ${endSec}::double precision,
          ${durSec}::double precision,
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
        SELECT text, start_sec, end_sec, dur_sec, ruby_html
        FROM listening_transcript_line
        WHERE video_id = ${videoId}
        ORDER BY line_index ASC
      `,
    );

    const lines = rows.map((line) => {
      const correctedText = TRANSCRIPT_LINE_CORRECTIONS.get(line.text) || line.text;
      const wasCorrected = correctedText !== line.text;
      return {
        text: correctedText,
        start: line.start_sec,
        end: line.end_sec,
        dur: line.dur_sec,
        rubyHtml: wasCorrected ? COMB_HAIR_RUBY_HTML : line.ruby_html || '',
      };
    });

    return res.json({ videoId, lines });
  });

  return router;
}
