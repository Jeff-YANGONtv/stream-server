import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../utils/errors.js';

interface TokenPayload { v: 1; id: string; exp: number; }

function signature(encodedPayload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest();
}

export function createSignedToken(id: string, secret: string | undefined, ttlSeconds = 3600, now = Date.now()): string {
  if (!secret) throw new AppError('Signed URL service is not configured', 503, 'TOKEN_NOT_CONFIGURED');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 30 * 24 * 3600) {
    throw new AppError('Token lifetime must be between 1 second and 30 days', 400, 'INVALID_TTL');
  }
  const payload: TokenPayload = { v: 1, id, exp: Math.floor(now / 1000) + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${signature(encoded, secret).toString('base64url')}`;
}

export function verifySignedToken(token: string, secret: string | undefined, now = Date.now()): string {
  if (!secret) throw new AppError('Signed URL service is not configured', 503, 'TOKEN_NOT_CONFIGURED');
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Malformed token');
    const [encoded, supplied] = parts as [string, string];
    const actual = Buffer.from(supplied, 'base64url');
    const expected = signature(encoded, secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid signature');
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<TokenPayload>;
    if (decoded.v !== 1 || typeof decoded.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(decoded.id) ||
        typeof decoded.exp !== 'number' || !Number.isSafeInteger(decoded.exp) || decoded.exp <= Math.floor(now / 1000)) {
      throw new Error('Invalid or expired payload');
    }
    return decoded.id;
  } catch {
    throw new AppError('Invalid or expired token', 403, 'INVALID_TOKEN');
  }
}
