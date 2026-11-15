import { Request } from 'express';
import { readBearerToken, verifyAuthToken } from './authToken';

export type ContentAccess = {
  isPremium: boolean;
  userId: number | null;
};

function readUserId(req: Request): number | null {
  const token = readBearerToken(req.header('Authorization'));
  const decoded = token ? verifyAuthToken(token) : null;
  return decoded?.userId ?? null;
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

// Legacy isPremium response field now means unrestricted learning content access.
// Paid entitlement checks above remain separate for historical payment records.
export async function resolveContentAccess(req: Request): Promise<ContentAccess> {
  const userId = readUserId(req);
  req.isPremium = true;
  req.premiumUserId = userId;
  return { isPremium: true, userId };
}
