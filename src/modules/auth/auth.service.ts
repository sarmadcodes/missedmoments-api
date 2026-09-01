import argon2 from 'argon2';
import { query, queryOne, transaction } from '../../lib/db.js';
import { conflict, unauthorized } from '../../lib/errors.js';
import { issueRefreshToken, signAccessToken } from '../../lib/tokens.js';

export type RegisterInput = {
  email: string;
  password: string;
  name: string;
  birthDate?: string | null;
  gender?: string | null;
  city?: string | null;
  phone?: string | null;
  bio?: string | null;
  interests?: string[];
};

// Argon2id with parameters sized for a small server. Raise memoryCost if the
// host allows it; this is the main defence for stored passwords.
const hashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB (OWASP minimum)
  timeCost: 2,
  parallelism: 1,
} as const;

const issueSession = async (userId: string) => ({
  accessToken: await signAccessToken(userId),
  refreshToken: await issueRefreshToken(userId),
});

export const register = async (input: RegisterInput) => {
  const existing = await queryOne('SELECT 1 FROM users WHERE email = $1', [input.email]);
  if (existing) {
    throw conflict('EMAIL_TAKEN', 'That email is already registered');
  }

  const passwordHash = await argon2.hash(input.password, hashOptions);

  const user = await transaction(async client => {
    const created = await queryOne<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, birth_date, gender, city, phone, bio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.email,
        passwordHash,
        input.name,
        input.birthDate ?? null,
        input.gender ?? null,
        input.city ?? null,
        input.phone ?? null,
        input.bio ?? null,
      ],
      client,
    );

    if (input.interests?.length) {
      await query(
        `INSERT INTO user_interests (user_id, interest_id)
         SELECT $1, unnest($2::text[])
         ON CONFLICT DO NOTHING`,
        [created!.id, input.interests],
        client,
      );
    }

    return created!;
  });

  return { userId: user.id, ...(await issueSession(user.id)) };
};

export const login = async (email: string, password: string) => {
  const user = await queryOne<{
    id: string;
    password_hash: string | null;
    status: string;
  }>('SELECT id, password_hash, status FROM users WHERE email = $1', [email]);

  // Always run a verify, even when the user does not exist, so response time
  // does not reveal which emails are registered.
  const hash =
    user?.password_hash ??
    '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';

  let ok = false;
  try {
    ok = await argon2.verify(hash, password);
  } catch {
    ok = false;
  }

  if (!user || !user.password_hash || !ok) {
    throw unauthorized('Incorrect email or password');
  }

  if (user.status === 'deleted') {
    throw unauthorized('This account no longer exists');
  }

  // Signing in reverses a "take a break" deactivation.
  if (user.status === 'deactivated') {
    await query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
  }

  return { userId: user.id, ...(await issueSession(user.id)) };
};

export const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string,
) => {
  const user = await queryOne<{ password_hash: string | null }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  );

  if (!user?.password_hash || !(await argon2.verify(user.password_hash, currentPassword))) {
    throw unauthorized('Current password is incorrect');
  }

  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
    userId,
    await argon2.hash(newPassword, hashOptions),
  ]);
};
