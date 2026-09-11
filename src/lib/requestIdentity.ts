import { Request } from 'express';
import { readBearerToken, verifyAuthToken } from './authToken';

// req.ip is resolved by Express using the explicitly configured trusted proxies.
// Never accept identity or localhost exemptions from client-controlled headers.
export function getClientIp(req: Request): string {
  return (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

export function isLocalRequest(req: Request, _clientIp?: string): boolean {
  if (process.env.NODE_ENV !== 'development') return false;
  const peer = req.socket?.remoteAddress;
  return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
}

export function authenticatedUserId(req: Request): string | null {
  const token = readBearerToken(req.header('Authorization'));
  const payload = token ? verifyAuthToken(token) : null;
  return payload ? String(payload.userId) : null;
}

export function canonicalRateScope(value: string): string {
  return value.replace(/^api-/, '');
}
