import { Request } from 'express';
import { prisma } from './prisma';

export type ContentAccess = {
  isPremium: boolean;
  userId: number | null;
};

function readUserId(req: Request): number | null {
  const raw = req.header('X-User-Id') || req.query.userId;
  const userId = Number(raw);
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

export function isPremiumRole(role: unknown): boolean {
  const normalized = String(role || '').trim().toUpperCase();
  return normalized.includes('ADMIN') || normalized.includes('PREMIUM');
}

export function hasActivePremium(user: {
  role?: string | null;
  plan?: string | null;
  premiumValidUntil?: Date | string | null;
} | null | undefined): boolean {
  if (!user) return false;
  if (isPremiumRole(user.role)) return true;
  if (String(user.plan || '').toUpperCase() !== 'PREMIUM') return false;
  const validUntil = user.premiumValidUntil ? new Date(user.premiumValidUntil) : null;
  return Boolean(validUntil && Number.isFinite(validUntil.getTime()) && validUntil.getTime() > Date.now());
}

export async function resolveContentAccess(req: Request): Promise<ContentAccess> {
  if (typeof req.isPremium === 'boolean') {
    return {
      isPremium: req.isPremium,
      userId: req.premiumUserId ?? null,
    };
  }

  const userId = readUserId(req);
  if (!userId) {
    req.isPremium = false;
    req.premiumUserId = null;
    return { isPremium: false, userId: null };
  }

  const user = await prisma.userAccount.findUnique({
    where: { id: BigInt(userId) },
    select: {
      role: true,
      plan: true,
      premiumValidUntil: true,
    },
  });

  const isPremium = hasActivePremium(user);
  req.isPremium = isPremium;
  req.premiumUserId = user ? userId : null;
  return { isPremium, userId: user ? userId : null };
}
