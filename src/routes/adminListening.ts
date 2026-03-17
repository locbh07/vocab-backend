import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAdmin } from '../middleware/adminGuard';

const DEFAULT_GUEST_LISTENING_VIDEO_LIMIT = Math.max(1, Number(process.env.GUEST_LISTENING_VIDEO_LIMIT || 7));
const DEFAULT_USER_LISTENING_VIDEO_LIMIT = Math.max(1, Number(process.env.USER_LISTENING_VIDEO_LIMIT || 15));
let ensureListeningAdminTablePromise: Promise<void> | null = null;

async function ensureListeningAdminTables() {
  if (!ensureListeningAdminTablePromise) {
    ensureListeningAdminTablePromise = (async () => {
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
      ensureListeningAdminTablePromise = null;
      throw error;
    });
  }
  return ensureListeningAdminTablePromise;
}

function normalizeViewerKey(input: unknown): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.startsWith('guest:')) return raw.slice(0, 180);
  return `guest:${raw.slice(0, 160)}`;
}

export function createAdminListeningRouter() {
  const router = Router();

  router.get('/policy', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensureListeningAdminTables();
    const rows = await prisma.$queryRaw<
      Array<{
        guest_gate_enabled: boolean;
        guest_video_limit: number;
        user_gate_enabled: boolean;
        user_video_limit: number;
        updated_at: Date;
      }>
    >(
      Prisma.sql`
        SELECT guest_gate_enabled, guest_video_limit, user_gate_enabled, user_video_limit, updated_at
        FROM listening_access_policy
        WHERE id = 1
        LIMIT 1
      `,
    );
    const row = rows[0];
    return res.json({
      guestGateEnabled: row ? Boolean(row.guest_gate_enabled) : true,
      guestVideoLimit: row
        ? Math.max(1, Number(row.guest_video_limit || DEFAULT_GUEST_LISTENING_VIDEO_LIMIT))
        : DEFAULT_GUEST_LISTENING_VIDEO_LIMIT,
      userGateEnabled: row ? Boolean(row.user_gate_enabled) : true,
      userVideoLimit: row
        ? Math.max(1, Number(row.user_video_limit || DEFAULT_USER_LISTENING_VIDEO_LIMIT))
        : DEFAULT_USER_LISTENING_VIDEO_LIMIT,
      updatedAt: row?.updated_at || null,
    });
  });

  router.put('/policy', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensureListeningAdminTables();

    const hasGuestGateEnabled = Object.prototype.hasOwnProperty.call(req.body || {}, 'guestGateEnabled');
    const hasGuestVideoLimit = Object.prototype.hasOwnProperty.call(req.body || {}, 'guestVideoLimit');
    const hasUserGateEnabled = Object.prototype.hasOwnProperty.call(req.body || {}, 'userGateEnabled');
    const hasUserVideoLimit = Object.prototype.hasOwnProperty.call(req.body || {}, 'userVideoLimit');
    if (!hasGuestGateEnabled && !hasGuestVideoLimit && !hasUserGateEnabled && !hasUserVideoLimit) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    const guestGateEnabled = hasGuestGateEnabled ? Boolean(req.body?.guestGateEnabled) : null;
    const parsedGuestLimit = Number(req.body?.guestVideoLimit);
    const guestVideoLimit = hasGuestVideoLimit
      ? Math.min(
          Math.max(
            Number.isFinite(parsedGuestLimit) ? Math.floor(parsedGuestLimit) : DEFAULT_GUEST_LISTENING_VIDEO_LIMIT,
            1,
          ),
          1000,
        )
      : null;

    const userGateEnabled = hasUserGateEnabled ? Boolean(req.body?.userGateEnabled) : null;
    const parsedUserLimit = Number(req.body?.userVideoLimit);
    const userVideoLimit = hasUserVideoLimit
      ? Math.min(
          Math.max(Number.isFinite(parsedUserLimit) ? Math.floor(parsedUserLimit) : DEFAULT_USER_LISTENING_VIDEO_LIMIT, 1),
          1000,
        )
      : null;

    await prisma.$executeRaw(
      Prisma.sql`
        UPDATE listening_access_policy
        SET
          guest_gate_enabled = COALESCE(${guestGateEnabled}, guest_gate_enabled),
          guest_video_limit = COALESCE(${guestVideoLimit}, guest_video_limit),
          user_gate_enabled = COALESCE(${userGateEnabled}, user_gate_enabled),
          user_video_limit = COALESCE(${userVideoLimit}, user_video_limit),
          updated_at = NOW()
        WHERE id = 1
      `,
    );

    const rows = await prisma.$queryRaw<
      Array<{
        guest_gate_enabled: boolean;
        guest_video_limit: number;
        user_gate_enabled: boolean;
        user_video_limit: number;
        updated_at: Date;
      }>
    >(
      Prisma.sql`
        SELECT guest_gate_enabled, guest_video_limit, user_gate_enabled, user_video_limit, updated_at
        FROM listening_access_policy
        WHERE id = 1
        LIMIT 1
      `,
    );
    const row = rows[0];
    return res.json({
      updated: true,
      guestGateEnabled: row ? Boolean(row.guest_gate_enabled) : true,
      guestVideoLimit: row
        ? Math.max(1, Number(row.guest_video_limit || DEFAULT_GUEST_LISTENING_VIDEO_LIMIT))
        : DEFAULT_GUEST_LISTENING_VIDEO_LIMIT,
      userGateEnabled: row ? Boolean(row.user_gate_enabled) : true,
      userVideoLimit: row
        ? Math.max(1, Number(row.user_video_limit || DEFAULT_USER_LISTENING_VIDEO_LIMIT))
        : DEFAULT_USER_LISTENING_VIDEO_LIMIT,
      updatedAt: row?.updated_at || null,
    });
  });

  router.get('/guest-access', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensureListeningAdminTables();

    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(Number(req.query.page || 0), 0);
    const size = Math.min(Math.max(Number(req.query.size || 20), 1), 200);
    const offset = page * size;
    const hasKeyword = keyword.length > 0;
    const token = `%${keyword}%`;

    const rows = await prisma.$queryRaw<
      Array<{ viewer_key: string; viewed_count: bigint | number; last_seen: Date | null; first_seen: Date | null }>
    >(
      Prisma.sql`
        SELECT
          viewer_key,
          COUNT(*)::bigint AS viewed_count,
          MAX(last_seen) AS last_seen,
          MIN(first_seen) AS first_seen
        FROM listening_guest_video_access
        ${hasKeyword ? Prisma.sql`WHERE viewer_key ILIKE ${token}` : Prisma.sql``}
        GROUP BY viewer_key
        ORDER BY MAX(last_seen) DESC
        LIMIT ${size}
        OFFSET ${offset}
      `,
    );

    const totalRows = await prisma.$queryRaw<Array<{ total: bigint | number }>>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS total
        FROM (
          SELECT viewer_key
          FROM listening_guest_video_access
          ${hasKeyword ? Prisma.sql`WHERE viewer_key ILIKE ${token}` : Prisma.sql``}
          GROUP BY viewer_key
        ) t
      `,
    );

    return res.json({
      items: rows.map((item) => ({
        viewerKey: item.viewer_key,
        viewedCount: Number(item.viewed_count || 0),
        firstSeen: item.first_seen,
        lastSeen: item.last_seen,
      })),
      page,
      size,
      total: Number(totalRows[0]?.total || 0),
    });
  });

  router.delete('/guest-access/:viewerKey', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensureListeningAdminTables();
    const normalized = normalizeViewerKey(req.params.viewerKey);
    if (!normalized) return res.status(400).json({ message: 'viewerKey is required' });

    const affected = await prisma.$executeRaw(
      Prisma.sql`
        DELETE FROM listening_guest_video_access
        WHERE viewer_key = ${normalized}
      `,
    );
    return res.json({ cleared: true, viewerKey: normalized, deletedRows: Number(affected || 0) });
  });

  router.get('/user-access', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensureListeningAdminTables();

    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(Number(req.query.page || 0), 0);
    const size = Math.min(Math.max(Number(req.query.size || 20), 1), 200);
    const offset = page * size;
    const hasKeyword = keyword.length > 0;
    const token = `%${keyword}%`;

    const rows = await prisma.$queryRaw<
      Array<{
        user_id: bigint | number;
        username: string | null;
        fullname: string | null;
        viewed_count: bigint | number;
        last_seen: Date | null;
        first_seen: Date | null;
        gate_enabled: boolean | null;
        video_limit: number | null;
      }>
    >(
      Prisma.sql`
        WITH viewed AS (
          SELECT
            user_id,
            COUNT(*)::bigint AS viewed_count,
            MAX(last_seen) AS last_seen,
            MIN(first_seen) AS first_seen
          FROM listening_user_video_access
          GROUP BY user_id
        )
        SELECT
          u.id AS user_id,
          u.username,
          u.fullname,
          COALESCE(v.viewed_count, 0)::bigint AS viewed_count,
          v.last_seen,
          v.first_seen,
          q.gate_enabled,
          q.video_limit
        FROM useraccount u
        LEFT JOIN viewed v ON v.user_id = u.id
        LEFT JOIN listening_user_quota q ON q.user_id = u.id
        WHERE ${hasKeyword
          ? Prisma.sql`(u.username ILIKE ${token} OR u.fullname ILIKE ${token} OR CAST(u.id AS TEXT) ILIKE ${token})`
          : Prisma.sql`TRUE`}
        ORDER BY COALESCE(v.last_seen, u.createdat) DESC, u.id DESC
        LIMIT ${size}
        OFFSET ${offset}
      `,
    );

    const totalRows = await prisma.$queryRaw<Array<{ total: bigint | number }>>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS total
        FROM useraccount u
        WHERE ${hasKeyword
          ? Prisma.sql`(u.username ILIKE ${token} OR u.fullname ILIKE ${token} OR CAST(u.id AS TEXT) ILIKE ${token})`
          : Prisma.sql`TRUE`}
      `,
    );

    return res.json({
      items: rows.map((item) => ({
        userId: Number(item.user_id),
        username: item.username || '',
        fullName: item.fullname || '',
        viewedCount: Number(item.viewed_count || 0),
        firstSeen: item.first_seen,
        lastSeen: item.last_seen,
        quotaOverride: {
          gateEnabled: item.gate_enabled,
          videoLimit: item.video_limit,
        },
      })),
      page,
      size,
      total: Number(totalRows[0]?.total || 0),
    });
  });

  router.get('/user-access/:userId', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensureListeningAdminTables();

    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ message: 'Invalid userId' });
    const userBigId = BigInt(userId);

    const [policy] = await prisma.$queryRaw<Array<{ user_gate_enabled: boolean; user_video_limit: number }>>(
      Prisma.sql`
        SELECT user_gate_enabled, user_video_limit
        FROM listening_access_policy
        WHERE id = 1
        LIMIT 1
      `,
    );
    const [quota] = await prisma.$queryRaw<Array<{ gate_enabled: boolean | null; video_limit: number | null; note: string | null }>>(
      Prisma.sql`
        SELECT gate_enabled, video_limit, note
        FROM listening_user_quota
        WHERE user_id = ${userBigId}
        LIMIT 1
      `,
    );
    const [count] = await prisma.$queryRaw<Array<{ total: bigint | number }>>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS total
        FROM listening_user_video_access
        WHERE user_id = ${userBigId}
      `,
    );
    const effectiveLimit = Math.max(
      1,
      Number(quota?.video_limit || policy?.user_video_limit || DEFAULT_USER_LISTENING_VIDEO_LIMIT),
    );
    const effectiveGateEnabled = quota?.gate_enabled === null || quota?.gate_enabled === undefined
      ? Boolean(policy?.user_gate_enabled ?? true)
      : Boolean(quota.gate_enabled);

    return res.json({
      userId,
      viewedCount: Number(count?.total || 0),
      quotaOverride: {
        gateEnabled: quota?.gate_enabled ?? null,
        videoLimit: quota?.video_limit ?? null,
        note: quota?.note || '',
      },
      effective: {
        gateEnabled: effectiveGateEnabled,
        videoLimit: effectiveLimit,
      },
    });
  });

  router.put('/user-access/:userId', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensureListeningAdminTables();

    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ message: 'Invalid userId' });
    const userBigId = BigInt(userId);

    const hasGateEnabled = Object.prototype.hasOwnProperty.call(req.body || {}, 'gateEnabled');
    const hasVideoLimit = Object.prototype.hasOwnProperty.call(req.body || {}, 'videoLimit');
    const hasNote = Object.prototype.hasOwnProperty.call(req.body || {}, 'note');
    const resetViewedHistory = Boolean(req.body?.resetViewedHistory);

    if (!hasGateEnabled && !hasVideoLimit && !hasNote && !resetViewedHistory) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    const gateEnabled =
      hasGateEnabled && req.body?.gateEnabled !== null && req.body?.gateEnabled !== undefined
        ? Boolean(req.body?.gateEnabled)
        : null;
    const parsedVideoLimit = Number(req.body?.videoLimit);
    const videoLimit =
      hasVideoLimit && req.body?.videoLimit !== null && req.body?.videoLimit !== undefined
        ? Math.min(
            Math.max(Number.isFinite(parsedVideoLimit) ? Math.floor(parsedVideoLimit) : DEFAULT_USER_LISTENING_VIDEO_LIMIT, 1),
            1000,
          )
        : null;
    const note =
      hasNote && req.body?.note !== null && req.body?.note !== undefined
        ? String(req.body?.note || '').slice(0, 1000)
        : null;

    if (hasGateEnabled || hasVideoLimit || hasNote) {
      await prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO listening_user_quota (user_id, gate_enabled, video_limit, note, created_at, updated_at)
          VALUES (${userBigId}, ${gateEnabled}, ${videoLimit}, ${note}, NOW(), NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            gate_enabled = CASE WHEN ${hasGateEnabled} THEN ${gateEnabled} ELSE listening_user_quota.gate_enabled END,
            video_limit = CASE WHEN ${hasVideoLimit} THEN ${videoLimit} ELSE listening_user_quota.video_limit END,
            note = CASE WHEN ${hasNote} THEN ${note} ELSE listening_user_quota.note END,
            updated_at = NOW()
        `,
      );
    }

    let resetDeleted = 0;
    if (resetViewedHistory) {
      const affected = await prisma.$executeRaw(
        Prisma.sql`
          DELETE FROM listening_user_video_access
          WHERE user_id = ${userBigId}
        `,
      );
      resetDeleted = Number(affected || 0);
    }

    return res.json({
      updated: true,
      userId,
      resetDeleted,
    });
  });

  router.delete('/user-access/:userId', async (req: Request, res: Response) => {
    await requireAdmin(req);
    await ensureListeningAdminTables();

    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ message: 'Invalid userId' });
    const userBigId = BigInt(userId);

    const affected = await prisma.$executeRaw(
      Prisma.sql`
        DELETE FROM listening_user_video_access
        WHERE user_id = ${userBigId}
      `,
    );
    return res.json({ cleared: true, userId, deletedRows: Number(affected || 0) });
  });

  return router;
}
