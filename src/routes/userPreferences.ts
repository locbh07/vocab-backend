import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

const DEFAULT_ORDER = ['vi', 'ja', 'hira', 'romaji', 'example_ja', 'example_vi', 'image'];
const ORDER_SET = new Set(DEFAULT_ORDER);
const LEGACY_EXPAND: Record<string, string[]> = {
  kana: ['hira', 'romaji'],
  example: ['example_ja', 'example_vi'],
};

const DEFAULT_VISIBILITY: Record<string, boolean> = {
  vi: true,
  ja: true,
  hira: true,
  romaji: true,
  example_ja: true,
  example_vi: true,
  image: true,
};

let tableReady = false;

async function ensurePreferenceTable() {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS user_ui_preference (
      user_id BIGINT PRIMARY KEY REFERENCES useraccount(id) ON DELETE CASCADE,
      vocab_card_order JSONB NOT NULL,
      vocab_card_visibility JSONB NOT NULL,
      updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  tableReady = true;
}

function normalizeVisibility(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') return { ...DEFAULT_VISIBILITY };
  const visibility = { ...DEFAULT_VISIBILITY };
  if (typeof (value as Record<string, unknown>).kana === 'boolean') {
    const legacy = (value as Record<string, boolean>).kana;
    visibility.hira = legacy;
    visibility.romaji = legacy;
  }
  if (typeof (value as Record<string, unknown>).example === 'boolean') {
    const legacy = (value as Record<string, boolean>).example;
    visibility.example_ja = legacy;
    visibility.example_vi = legacy;
  }
  for (const key of Object.keys(DEFAULT_VISIBILITY)) {
    if (typeof (value as Record<string, unknown>)[key] === 'boolean') {
      visibility[key] = (value as Record<string, boolean>)[key];
    }
  }
  return visibility;
}

function normalizeOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_ORDER];
  const expanded: string[] = [];
  for (const item of value) {
    const key = String(item);
    if (LEGACY_EXPAND[key]) {
      expanded.push(...LEGACY_EXPAND[key]);
    } else {
      expanded.push(key);
    }
  }
  const unique: string[] = [];
  for (const key of expanded) {
    if (!ORDER_SET.has(key)) continue;
    if (!unique.includes(key)) unique.push(key);
  }
  for (const key of DEFAULT_ORDER) {
    if (!unique.includes(key)) unique.push(key);
  }
  return unique;
}

export function createUserPreferencesRouter() {
  const router = Router();

  router.get('/vocab-card', async (req: Request, res: Response) => {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid userId' });
    }

    await ensurePreferenceTable();
    const rows = await prisma.$queryRaw<
      Array<{
        vocab_card_order: unknown;
        vocab_card_visibility: unknown;
      }>
    >`
      SELECT vocab_card_order, vocab_card_visibility
      FROM user_ui_preference
      WHERE user_id = ${BigInt(userId)}
      LIMIT 1
    `;

    const row = rows[0];
    return res.json({
      success: true,
      data: {
        order: normalizeOrder(row?.vocab_card_order),
        visibility: normalizeVisibility(row?.vocab_card_visibility),
      },
    });
  });

  router.put('/vocab-card', async (req: Request, res: Response) => {
    const userId = Number(req.body?.userId);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid userId' });
    }

    const order = normalizeOrder(req.body?.order);
    const visibility = normalizeVisibility(req.body?.visibility);

    await ensurePreferenceTable();
    await prisma.$executeRaw`
      INSERT INTO user_ui_preference (user_id, vocab_card_order, vocab_card_visibility, updated_at)
      VALUES (${BigInt(userId)}, ${JSON.stringify(order)}::jsonb, ${JSON.stringify(visibility)}::jsonb, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        vocab_card_order = EXCLUDED.vocab_card_order,
        vocab_card_visibility = EXCLUDED.vocab_card_visibility,
        updated_at = NOW()
    `;

    return res.json({
      success: true,
      data: { order, visibility },
    });
  });

  return router;
}
