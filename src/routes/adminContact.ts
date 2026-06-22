import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ensureContactTables, readContactSettings } from '../lib/contactStore';
import { requireAdmin } from '../middleware/adminGuard';

const ALLOWED_PLATFORMS = new Set([
  'TIKTOK',
  'TELEGRAM',
  'MESSENGER',
  'FACEBOOK',
  'ZALO',
  'YOUTUBE',
  'OTHER',
]);
const MAX_CHANNELS = 8;
const MAX_QR_BYTES = 1024 * 1024;
const MAX_TOTAL_QR_BYTES = 2.5 * 1024 * 1024;

type NormalizedChannel = {
  platform: string;
  label: string;
  handle: string | null;
  url: string | null;
  qrImage: string | null;
  enabled: boolean;
  sortOrder: number;
};

export function createAdminContactRouter() {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    await requireAdmin(req);
    return res.json(await readContactSettings(true));
  });

  router.put('/', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    await ensureContactTables();

    const eyebrow = normalizeRequiredText(req.body?.eyebrow, 'eyebrow', 80);
    const title = normalizeRequiredText(req.body?.title, 'title', 200);
    const description = normalizeRequiredText(req.body?.description, 'description', 2000);
    const email = normalizeOptionalText(req.body?.email, 255);
    const phone = normalizeOptionalText(req.body?.phone, 50);
    const address = normalizeOptionalText(req.body?.address, 500);
    const rawChannels: unknown[] = Array.isArray(req.body?.channels) ? req.body.channels : [];

    if (rawChannels.length > MAX_CHANNELS) {
      return res.status(400).json({ message: `Chỉ được cấu hình tối đa ${MAX_CHANNELS} kênh liên hệ.` });
    }

    const channels = rawChannels.map((channel, index) => normalizeChannel(channel, index));
    const totalQrBytes = channels.reduce((total, channel) => total + dataUrlBytes(channel.qrImage), 0);
    if (totalQrBytes > MAX_TOTAL_QR_BYTES) {
      return res.status(400).json({ message: 'Tổng dung lượng ảnh QR không được vượt quá 2.5 MB.' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE site_contact_settings
        SET eyebrow = ${eyebrow}, title = ${title}, description = ${description},
            email = ${email}, phone = ${phone}, address = ${address},
            updated_by = ${BigInt(admin.id)}, updated_at = NOW()
        WHERE id = 1
      `;
      await tx.$executeRaw`DELETE FROM site_contact_channel`;

      for (const channel of channels) {
        await tx.$executeRaw`
          INSERT INTO site_contact_channel (
            platform, label, handle, url, qr_image, enabled, sort_order
          ) VALUES (
            ${channel.platform}, ${channel.label}, ${channel.handle}, ${channel.url},
            ${channel.qrImage}, ${channel.enabled}, ${channel.sortOrder}
          )
        `;
      }
    });

    return res.json(await readContactSettings(true));
  });

  return router;
}

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(`${field} không được để trống.`) as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  if (text.length > maxLength) {
    const error = new Error(`${field} vượt quá ${maxLength} ký tự.`) as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  return text;
}

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > maxLength) {
    const error = new Error(`Nội dung vượt quá ${maxLength} ký tự.`) as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  return text;
}

function normalizeChannel(value: any, index: number): NormalizedChannel {
  const platform = String(value?.platform || '').trim().toUpperCase();
  if (!ALLOWED_PLATFORMS.has(platform)) {
    const error = new Error(`Nền tảng ở kênh ${index + 1} không hợp lệ.`) as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const label = normalizeRequiredText(value?.label, `Tên kênh ${index + 1}`, 80);
  const handle = normalizeOptionalText(value?.handle, 120);
  const url = normalizeUrl(value?.url, index);
  const qrImage = normalizeQrImage(value?.qrImage, index);

  return {
    platform,
    label,
    handle,
    url,
    qrImage,
    enabled: value?.enabled !== false,
    sortOrder: index,
  };
}

function normalizeUrl(value: unknown, index: number): string | null {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('invalid protocol');
    return parsed.toString();
  } catch {
    const error = new Error(`Đường dẫn ở kênh ${index + 1} không hợp lệ.`) as Error & { status?: number };
    error.status = 400;
    throw error;
  }
}

function normalizeQrImage(value: unknown, index: number): string | null {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    const error = new Error(`QR ở kênh ${index + 1} phải là ảnh PNG, JPEG hoặc WEBP.`) as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  const bytes = Math.floor((match[2].length * 3) / 4);
  if (bytes > MAX_QR_BYTES) {
    const error = new Error(`QR ở kênh ${index + 1} vượt quá 1 MB.`) as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  return text;
}

function dataUrlBytes(value: string | null): number {
  if (!value) return 0;
  const base64 = value.slice(value.indexOf(',') + 1);
  return Math.floor((base64.length * 3) / 4);
}
