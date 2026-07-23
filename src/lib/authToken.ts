import jwt from 'jsonwebtoken';

export type AuthTokenPayload = {
  userId: number;
  impersonatedBy?: number;
};

const DEFAULT_DEV_SECRET = 'dev-only-insecure-secret-do-not-use-in-production';

function getSecret(): string {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is not configured');
  }
  return DEFAULT_DEV_SECRET;
}

const NORMAL_SESSION_TTL = '30d';
const IMPERSONATION_SESSION_TTL = '30m';

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, getSecret(), {
    expiresIn: payload.impersonatedBy ? IMPERSONATION_SESSION_TTL : NORMAL_SESSION_TTL,
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret());
    if (!decoded || typeof decoded !== 'object') return null;
    const userId = Number((decoded as Record<string, unknown>).userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return null;
    const impersonatedByRaw = (decoded as Record<string, unknown>).impersonatedBy;
    const impersonatedBy = impersonatedByRaw !== undefined ? Number(impersonatedByRaw) : undefined;
    return {
      userId,
      ...(Number.isSafeInteger(impersonatedBy) && impersonatedBy! > 0 ? { impersonatedBy } : {}),
    };
  } catch {
    return null;
  }
}

export function readBearerToken(header: string | undefined | null): string {
  const raw = String(header || '').trim();
  if (!raw) return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}
