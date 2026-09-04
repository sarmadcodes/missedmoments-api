import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { query, queryOne, type Sql } from './db.js';
import { unauthorized } from './errors.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);

export type AccessClaims = { sub: string };

export const signAccessToken = (userId: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer('missedmoments')
    .setAudience('missedmoments-app')
    .setExpirationTime(config.ACCESS_TOKEN_TTL)
    .sign(secret);

export const verifyAccessToken = async (token: string): Promise<AccessClaims> => {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: 'missedmoments',
      audience: 'missedmoments-app',
    });
    if (!payload.sub) throw new Error('missing sub');
    return { sub: payload.sub };
  } catch {
    throw unauthorized('Invalid or expired token');
  }
};

// Refresh tokens are opaque random strings. Only their SHA-256 is stored, so a
// database dump cannot be replayed into live sessions.
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export const issueRefreshToken = async (userId: string, client?: Sql) => {
  const token = randomBytes(48).toString('base64url');
  const expiresAt = new Date(
    Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hash(token), expiresAt],
    client,
  );

  return token;
};

/**
 * Verifies a refresh token and rotates it: the presented token is revoked and
 * a fresh one issued, so a stolen token is usable at most once.
 */
export const rotateRefreshToken = async (token: string) => {
  // Joined against the user's current status so a mid-session suspend/ban
  // takes effect on this user's next token refresh (at most one access-token
  // TTL later) rather than only blocking a fresh login up to 30 days later.
  const row = await queryOne<{ id: string; user_id: string; status: string }>(
    `SELECT rt.id, rt.user_id, u.status
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1
        AND rt.revoked_at IS NULL
        AND rt.expires_at > now()`,
    [hash(token)],
  );

  if (!row) throw unauthorized('Session expired');

  if (row.status !== 'active' && row.status !== 'deactivated') {
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
    throw unauthorized('This account is no longer available');
  }

  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
  const refreshToken = await issueRefreshToken(row.user_id);
  const accessToken = await signAccessToken(row.user_id);

  return { accessToken, refreshToken, userId: row.user_id };
};

export const revokeAllRefreshTokens = (userId: string) =>
  query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
