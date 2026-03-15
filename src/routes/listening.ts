import { Request, Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

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
};

type TranscriptRow = {
  text: string;
  start_sec: number | null;
  end_sec: number | null;
  dur_sec: number | null;
  ruby_html: string | null;
};

function normalizeLevel(input: unknown) {
  return String(input || '').trim().toLowerCase();
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
  };
}

export function createListeningRouter() {
  const router = Router();

  router.get('/videos', async (req: Request, res: Response) => {
    const q = String(req.query.q || '').trim();
    const level = normalizeLevel(req.query.level);
    const limitRaw = Number(req.query.limit || 300);
    const limit = Math.min(Math.max(limitRaw, 1), 500);
    const predicates: Prisma.Sql[] = [];

    if (q) {
      predicates.push(
        Prisma.sql`(title ILIKE ${`%${q}%`} OR video_id ILIKE ${`%${q}%`})`,
      );
    }
    if (level) {
      predicates.push(
        Prisma.sql`(
          ${level} = ANY(normalized_levels)
          OR (COALESCE(array_length(normalized_levels, 1), 0) = 0 AND ${level} = ANY(levels))
        )`,
      );
    }

    const whereSql = predicates.length
      ? Prisma.sql`WHERE ${Prisma.join(predicates, ' AND ')}`
      : Prisma.sql``;

    const rows = await prisma.$queryRaw<ListeningVideoRow[]>(
      Prisma.sql`
        SELECT
          source_id, video_id, title, duration_sec, thumbnail, levels, normalized_levels, tags,
          category_label, created_relative, views, created_at_src, updated_at_src, video_url, embed_url
        FROM listening_video
        ${whereSql}
        ${predicates.length ? Prisma.sql`AND` : Prisma.sql`WHERE`} duration_sec > 0
        ORDER BY COALESCE(source_order, 2147483647) ASC, inserted_at ASC
        LIMIT ${limit}
      `,
    );

    const items = rows.map(mapVideo);
    return res.json({ items, total: items.length, limit });
  });

  router.get('/videos/:videoId', async (req: Request, res: Response) => {
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) {
      return res.status(400).json({ message: 'videoId is required' });
    }

    const rows = await prisma.$queryRaw<ListeningVideoRow[]>(
      Prisma.sql`
        SELECT
          source_id, video_id, title, duration_sec, thumbnail, levels, normalized_levels, tags,
          category_label, created_relative, views, created_at_src, updated_at_src, video_url, embed_url
        FROM listening_video
        WHERE video_id = ${videoId}
        LIMIT 1
      `,
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Video not found' });
    }
    return res.json(mapVideo(rows[0]));
  });

  router.get('/videos/:videoId/transcript', async (req: Request, res: Response) => {
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) {
      return res.status(400).json({ message: 'videoId is required' });
    }

    const rows = await prisma.$queryRaw<TranscriptRow[]>(
      Prisma.sql`
        SELECT text, start_sec, end_sec, dur_sec, ruby_html
        FROM listening_transcript_line
        WHERE video_id = ${videoId}
        ORDER BY line_index ASC
      `,
    );

    const lines = rows.map((line) => ({
      text: line.text,
      start: line.start_sec,
      end: line.end_sec,
      dur: line.dur_sec,
      rubyHtml: line.ruby_html || '',
    }));

    return res.json({ videoId, lines });
  });

  return router;
}
