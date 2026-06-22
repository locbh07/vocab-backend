import { prisma } from './prisma';

let ensureContactTablesPromise: Promise<void> | null = null;

export type ContactChannelRow = {
  id: bigint;
  platform: string;
  label: string;
  handle: string | null;
  url: string | null;
  qr_image: string | null;
  enabled: boolean;
  sort_order: number;
};

export type ContactSettingsRow = {
  eyebrow: string;
  title: string;
  description: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  updated_at: Date;
};

export async function ensureContactTables(): Promise<void> {
  if (!ensureContactTablesPromise) {
    ensureContactTablesPromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS site_contact_settings (
          id SMALLINT PRIMARY KEY,
          eyebrow VARCHAR(80) NOT NULL,
          title VARCHAR(200) NOT NULL,
          description TEXT NOT NULL,
          email VARCHAR(255),
          phone VARCHAR(50),
          address VARCHAR(500),
          updated_by BIGINT REFERENCES useraccount(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS site_contact_channel (
          id BIGSERIAL PRIMARY KEY,
          platform VARCHAR(30) NOT NULL,
          label VARCHAR(80) NOT NULL,
          handle VARCHAR(120),
          url TEXT,
          qr_image TEXT,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_site_contact_channel_order
          ON site_contact_channel(enabled, sort_order, id)
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO site_contact_settings (id, eyebrow, title, description)
        VALUES (
          1,
          'Kết nối với chúng tôi',
          'Đồng hành trên hành trình học tiếng Nhật',
          'Theo dõi các kênh chính thức hoặc liên hệ trực tiếp khi bạn cần hỗ trợ.'
        )
        ON CONFLICT (id) DO NOTHING
      `);
    })().catch((error) => {
      ensureContactTablesPromise = null;
      throw error;
    });
  }

  await ensureContactTablesPromise;
}

export async function readContactSettings(includeDisabled = false) {
  await ensureContactTables();
  const [settingsRows, channelRows] = await Promise.all([
    prisma.$queryRaw<Array<ContactSettingsRow>>`
      SELECT eyebrow, title, description, email, phone, address, updated_at
      FROM site_contact_settings
      WHERE id = 1
      LIMIT 1
    `,
    includeDisabled
      ? prisma.$queryRaw<Array<ContactChannelRow>>`
          SELECT id, platform, label, handle, url, qr_image, enabled, sort_order
          FROM site_contact_channel
          ORDER BY sort_order ASC, id ASC
        `
      : prisma.$queryRaw<Array<ContactChannelRow>>`
          SELECT id, platform, label, handle, url, qr_image, enabled, sort_order
          FROM site_contact_channel
          WHERE enabled = TRUE
          ORDER BY sort_order ASC, id ASC
        `,
  ]);

  const settings = settingsRows[0];
  return {
    eyebrow: settings?.eyebrow || '',
    title: settings?.title || '',
    description: settings?.description || '',
    email: settings?.email || '',
    phone: settings?.phone || '',
    address: settings?.address || '',
    updatedAt: settings?.updated_at || null,
    channels: channelRows.map((channel) => ({
      id: Number(channel.id),
      platform: channel.platform,
      label: channel.label,
      handle: channel.handle || '',
      url: channel.url || '',
      qrImage: channel.qr_image || '',
      enabled: Boolean(channel.enabled),
      sortOrder: Number(channel.sort_order),
    })),
  };
}
