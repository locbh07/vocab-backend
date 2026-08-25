import { prisma } from './prisma';

let ensureGameProfileTablePromise: Promise<void> | null = null;

export type GameProfileRow = {
  user_id: bigint;
  xp: number;
  total_games: number;
  current_streak: number;
  longest_streak: number;
  last_played_date: Date | null;
};

// Moved verbatim from learningGame.ts's ensureLearningGameTables() -- this is the
// single shared XP ledger, now written by both arcade mini-games and regular SRS
// review. user_game_session (arcade session history) stays defined in
// learningGame.ts; only the profile table moved here.
export async function ensureGameProfileTable(): Promise<void> {
  if (!ensureGameProfileTablePromise) {
    ensureGameProfileTablePromise = prisma
      .$executeRawUnsafe(
        `
        CREATE TABLE IF NOT EXISTS user_game_profile (
          user_id BIGINT PRIMARY KEY REFERENCES useraccount(id) ON DELETE CASCADE,
          xp INTEGER NOT NULL DEFAULT 0,
          total_games INTEGER NOT NULL DEFAULT 0,
          current_streak INTEGER NOT NULL DEFAULT 0,
          longest_streak INTEGER NOT NULL DEFAULT 0,
          last_played_date DATE NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      )
      .then(() => undefined)
      .catch((error) => {
        ensureGameProfileTablePromise = null;
        throw error;
      });
  }
  await ensureGameProfileTablePromise;
}

export async function ensureGameProfile(userId: number): Promise<GameProfileRow> {
  await ensureGameProfileTable();
  const userBigId = BigInt(userId);
  const [existing] = await prisma.$queryRaw<GameProfileRow[]>`
    SELECT user_id, xp, total_games, current_streak, longest_streak, last_played_date
    FROM user_game_profile
    WHERE user_id = ${userBigId}
    LIMIT 1
  `;
  if (existing) return existing;

  await prisma.$executeRawUnsafe(
    `
      INSERT INTO user_game_profile (user_id, xp, total_games, current_streak, longest_streak, last_played_date, created_at, updated_at)
      VALUES ($1, 0, 0, 0, 0, NULL, NOW(), NOW())
      ON CONFLICT (user_id) DO NOTHING
    `,
    userBigId,
  );

  const [created] = await prisma.$queryRaw<GameProfileRow[]>`
    SELECT user_id, xp, total_games, current_streak, longest_streak, last_played_date
    FROM user_game_profile
    WHERE user_id = ${userBigId}
    LIMIT 1
  `;
  return created;
}

export async function getXp(userId: number): Promise<number> {
  const profile = await ensureGameProfile(userId);
  return Number(profile.xp || 0);
}

/** Adds `amount` XP into the single shared ledger (user_game_profile.xp). */
export async function awardXp(userId: number, amount: number): Promise<number> {
  const rounded = Math.round(amount);
  if (!Number.isFinite(rounded) || rounded <= 0) return getXp(userId);
  await ensureGameProfile(userId); // guarantees the row exists before UPDATE
  const [row] = await prisma.$queryRawUnsafe<Array<{ xp: number }>>(
    `
      UPDATE user_game_profile
      SET xp = xp + $2, updated_at = NOW()
      WHERE user_id = $1
      RETURNING xp
    `,
    BigInt(userId),
    rounded,
  );
  return Number(row?.xp || 0);
}
