import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { jsonSafe } from '../lib/jsonSafe';

// Public codec key: deters casual copying, not a secret or authorization boundary.
const key = createHash('sha256').update('daisuki-content-envelope-v1').digest();
const aad = Buffer.from('daisuki-content-v1');
export function encodeContent(body: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(jsonSafe(body)), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { codec: 'daisuki-content-v1', iv: iv.toString('base64'), payload: ciphertext.toString('base64') };
}

export function contentEnvelope(req: Request, res: Response, next: NextFunction) {
  if (!/^\/(?:api\/)?(?:vocabulary|grammar|kanji|exam|listening|learning|books|speaking)(?:\/|$)/.test(req.path)) return next();
  res.set('Cache-Control', 'private, no-store');
  res.vary('X-Content-Codec');
  // Negotiation preserves existing API clients. Rate limits apply to both formats.
  if (req.header('X-Content-Codec') !== 'daisuki-content-v1') return next();
  const json = res.json.bind(res);
  res.json = (body: unknown) => json(res.statusCode >= 200 && res.statusCode < 300 ? encodeContent(body) : body);
  next();
}
