import { Request, Response, Router } from 'express';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
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

type CountRow = {
  total: bigint | number;
};

type ListeningAccessPolicy = {
  guestGateEnabled: boolean;
  guestVideoLimit: number;
  userGateEnabled: boolean;
  userVideoLimit: number;
};

const DEFAULT_GUEST_LISTENING_VIDEO_LIMIT = Math.max(1, Number(process.env.GUEST_LISTENING_VIDEO_LIMIT || 7));
const DEFAULT_USER_LISTENING_VIDEO_LIMIT = Math.max(1, Number(process.env.USER_LISTENING_VIDEO_LIMIT || 15));
const GUEST_COOKIE_NAME = 'jp_listening_guest_id';
let ensureListeningGuestAccessTablePromise: Promise<void> | null = null;

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

async function ensureListeningGuestAccessTable() {
  if (!ensureListeningGuestAccessTablePromise) {
    ensureListeningGuestAccessTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS listening_guest_video_access (
          id BIGSERIAL PRIMARY KEY,
          viewer_key VARCHAR(180) NOT NULL,
          video_id VARCHAR(50) NOT NULL,
          first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (viewer_key, video_id)
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_listening_guest_video_access_viewer_key
        ON listening_guest_video_access (viewer_key);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS listening_access_policy (
          id SMALLINT PRIMARY KEY,
          guest_gate_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          guest_video_limit INT NOT NULL DEFAULT ${DEFAULT_GUEST_LISTENING_VIDEO_LIMIT},
          user_gate_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          user_video_limit INT NOT NULL DEFAULT ${DEFAULT_USER_LISTENING_VIDEO_LIMIT},
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE listening_access_policy
        ADD COLUMN IF NOT EXISTS user_gate_enabled BOOLEAN NOT NULL DEFAULT TRUE;
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE listening_access_policy
        ADD COLUMN IF NOT EXISTS user_video_limit INT NOT NULL DEFAULT ${DEFAULT_USER_LISTENING_VIDEO_LIMIT};
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS listening_user_video_access (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL,
          video_id VARCHAR(50) NOT NULL,
          first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, video_id)
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_listening_user_video_access_user_id
        ON listening_user_video_access (user_id);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS listening_user_quota (
          user_id BIGINT PRIMARY KEY,
          gate_enabled BOOLEAN NULL,
          video_limit INT NULL,
          note TEXT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO listening_access_policy (id, guest_gate_enabled, guest_video_limit, user_gate_enabled, user_video_limit)
        VALUES (1, TRUE, ${DEFAULT_GUEST_LISTENING_VIDEO_LIMIT}, TRUE, ${DEFAULT_USER_LISTENING_VIDEO_LIMIT})
        ON CONFLICT (id) DO NOTHING;
      `);
    })().catch((error) => {
      ensureListeningGuestAccessTablePromise = null;
      throw error;
    });
  }
  return ensureListeningGuestAccessTablePromise;
}

async function getListeningAccessPolicy(): Promise<ListeningAccessPolicy> {
  await ensureListeningGuestAccessTable();
  const rows = await prisma.$queryRaw<
    Array<{ guest_gate_enabled: boolean; guest_video_limit: number; user_gate_enabled: boolean; user_video_limit: number }>
  >(
    Prisma.sql`
      SELECT guest_gate_enabled, guest_video_limit, user_gate_enabled, user_video_limit
      FROM listening_access_policy
      WHERE id = 1
      LIMIT 1
    `,
  );
  if (!rows.length) {
    return {
      guestGateEnabled: true,
      guestVideoLimit: DEFAULT_GUEST_LISTENING_VIDEO_LIMIT,
      userGateEnabled: true,
      userVideoLimit: DEFAULT_USER_LISTENING_VIDEO_LIMIT,
    };
  }
  return {
    guestGateEnabled: Boolean(rows[0].guest_gate_enabled),
    guestVideoLimit: Math.max(1, Number(rows[0].guest_video_limit || DEFAULT_GUEST_LISTENING_VIDEO_LIMIT)),
    userGateEnabled: Boolean(rows[0].user_gate_enabled),
    userVideoLimit: Math.max(1, Number(rows[0].user_video_limit || DEFAULT_USER_LISTENING_VIDEO_LIMIT)),
  };
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const source = String(cookieHeader || '');
  if (!source) return {};
  const out: Record<string, string> = {};
  source.split(';').forEach((item) => {
    const [rawKey, ...rawValue] = item.split('=');
    const key = String(rawKey || '').trim();
    if (!key) return;
    const value = String(rawValue.join('=') || '').trim();
    out[key] = decodeURIComponent(value);
  });
  return out;
}

function readUserId(req: Request): number | null {
  const queryValue = Number(req.query.userId);
  if (Number.isFinite(queryValue) && queryValue > 0) return queryValue;
  const headerValue = Number(req.header('x-user-id'));
  if (Number.isFinite(headerValue) && headerValue > 0) return headerValue;
  return null;
}

function resolveGuestViewerKey(req: Request, res: Response): string {
  const queryGuestKey = String(req.query.guestKey || '').trim();
  if (queryGuestKey) return `guest:${queryGuestKey.slice(0, 160)}`;

  const headerGuestKey = String(req.header('x-guest-id') || '').trim();
  if (headerGuestKey) return `guest:${headerGuestKey.slice(0, 160)}`;

  const cookies = parseCookies(req.headers.cookie);
  const existing = String(cookies[GUEST_COOKIE_NAME] || '').trim();
  if (existing) return `guest:${existing}`;

  const guestId = randomUUID();
  res.setHeader('Set-Cookie', `${GUEST_COOKIE_NAME}=${encodeURIComponent(guestId)}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return `guest:${guestId}`;
}

async function enforceGuestListeningAccess(
  req: Request,
  res: Response,
  videoId: string,
  policy: ListeningAccessPolicy,
): Promise<boolean> {
  if (!policy.guestGateEnabled) return true;
  const viewerKey = resolveGuestViewerKey(req, res);
  const normalizedVideoId = String(videoId || '').trim();
  if (!normalizedVideoId) return false;

  const existing = await prisma.$queryRaw<Array<{ id: bigint | number }>>(
    Prisma.sql`
      SELECT id
      FROM listening_guest_video_access
      WHERE viewer_key = ${viewerKey}
        AND video_id = ${normalizedVideoId}
      LIMIT 1
    `,
  );

  const countRows = await prisma.$queryRaw<CountRow[]>(
    Prisma.sql`
      SELECT COUNT(*)::bigint AS total
      FROM listening_guest_video_access
      WHERE viewer_key = ${viewerKey}
    `,
  );
  const viewedCount = Number(countRows[0]?.total || 0);

  if (!existing.length && viewedCount >= policy.guestVideoLimit) {
    res.status(403).json({
      code: 'GUEST_LISTENING_LIMIT_REACHED',
      message: `Bạn đã xem tối đa ${policy.guestVideoLimit} video ở chế độ chưa đăng nhập. Hãy đăng ký/đăng nhập để xem tiếp.`,
      limit: policy.guestVideoLimit,
      viewedCount,
      requiresAuth: true,
    });
    return false;
  }

  if (!existing.length) {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO listening_guest_video_access (
          viewer_key, video_id, first_seen, last_seen, created_at, updated_at
        )
        VALUES (${viewerKey}, ${normalizedVideoId}, NOW(), NOW(), NOW(), NOW())
        ON CONFLICT (viewer_key, video_id)
        DO UPDATE SET
          last_seen = NOW(),
          updated_at = NOW()
      `,
    );
    return true;
  }

  await prisma.$executeRaw(
    Prisma.sql`
      UPDATE listening_guest_video_access
      SET last_seen = NOW(), updated_at = NOW()
      WHERE viewer_key = ${viewerKey}
        AND video_id = ${normalizedVideoId}
    `,
  );
  return true;
}

async function enforceUserListeningAccess(
  userId: number,
  res: Response,
  videoId: string,
  policy: ListeningAccessPolicy,
): Promise<boolean> {
  if (!policy.userGateEnabled) return true;
  const normalizedVideoId = String(videoId || '').trim();
  if (!normalizedVideoId) return false;
  const userBigId = BigInt(userId);

  const quotaRows = await prisma.$queryRaw<Array<{ gate_enabled: boolean | null; video_limit: number | null }>>(
    Prisma.sql`
      SELECT gate_enabled, video_limit
      FROM listening_user_quota
      WHERE user_id = ${userBigId}
      LIMIT 1
    `,
  );
  const quota = quotaRows[0];
  const gateEnabledOverride = quota?.gate_enabled;
  if (gateEnabledOverride === false) return true;
  const effectiveLimit = Math.max(1, Number(quota?.video_limit || policy.userVideoLimit));

  const existing = await prisma.$queryRaw<Array<{ id: bigint | number }>>(
    Prisma.sql`
      SELECT id
      FROM listening_user_video_access
      WHERE user_id = ${userBigId}
        AND video_id = ${normalizedVideoId}
      LIMIT 1
    `,
  );
  const countRows = await prisma.$queryRaw<CountRow[]>(
    Prisma.sql`
      SELECT COUNT(*)::bigint AS total
      FROM listening_user_video_access
      WHERE user_id = ${userBigId}
    `,
  );
  const viewedCount = Number(countRows[0]?.total || 0);

  if (!existing.length && viewedCount >= effectiveLimit) {
    res.status(403).json({
      code: 'USER_LISTENING_LIMIT_REACHED',
      message: `Tài khoản của bạn đã xem tối đa ${effectiveLimit} video. Vui lòng liên hệ admin để mở thêm lượt xem.`,
      limit: effectiveLimit,
      viewedCount,
      requiresAdminApproval: true,
    });
    return false;
  }

  if (!existing.length) {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO listening_user_video_access (
          user_id, video_id, first_seen, last_seen, created_at, updated_at
        )
        VALUES (${userBigId}, ${normalizedVideoId}, NOW(), NOW(), NOW(), NOW())
        ON CONFLICT (user_id, video_id)
        DO UPDATE SET
          last_seen = NOW(),
          updated_at = NOW()
      `,
    );
    return true;
  }

  await prisma.$executeRaw(
    Prisma.sql`
      UPDATE listening_user_video_access
      SET last_seen = NOW(), updated_at = NOW()
      WHERE user_id = ${userBigId}
        AND video_id = ${normalizedVideoId}
    `,
  );
  return true;
}

async function enforceListeningAccess(req: Request, res: Response, videoId: string): Promise<boolean> {
  const policy = await getListeningAccessPolicy();
  const userId = readUserId(req);
  if (userId) {
    return enforceUserListeningAccess(userId, res, videoId, policy);
  }
  return enforceGuestListeningAccess(req, res, videoId, policy);
}

export function createListeningRouter() {
  const router = Router();

  router.get('/videos', async (req: Request, res: Response) => {
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
    if (!(await enforceListeningAccess(req, res, videoId))) return;

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
    if (!(await enforceListeningAccess(req, res, videoId))) return;

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
