import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne, transaction } from '../../lib/db.js';
import { notFound } from '../../lib/errors.js';
import { revokeAllRefreshTokens } from '../../lib/tokens.js';

const publicProfile = `
  SELECT u.id                    AS "userId",
         u.name,
         user_age(u.birth_date)  AS age,
         u.city,
         u.bio,
         COALESCE(
           (SELECT json_agg(p.url ORDER BY p.position)
              FROM user_photos p
             WHERE p.user_id = u.id AND p.moderation = 'approved'),
           '[]'::json)           AS photos,
         COALESCE(
           (SELECT json_agg(i.name)
              FROM user_interests ui
              JOIN interests i ON i.id = ui.interest_id
             WHERE ui.user_id = u.id),
           '[]'::json)           AS interests
    FROM users u
   WHERE u.id = $1 AND u.status = 'active'
`;

export default async function userRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/me', async req => {
    const me = await queryOne(
      `SELECT u.id AS "userId", u.email, u.name,
              user_age(u.birth_date) AS age, u.city, u.bio,
              u.is_discoverable AS "isDiscoverable",
              u.is_invisible AS "isInvisible",
              u.notify_all AS "notifyAll",
              u.notify_new_match AS "notifyNewMatch",
              u.created_at AS "joinedAt",
              p.url AS "photoUrl"
         FROM users u
         LEFT JOIN user_photos p
                ON p.user_id = u.id AND p.is_primary
        WHERE u.id = $1`,
      [req.userId],
    );
    if (!me) throw notFound('User not found');

    const stats = await queryOne(
      `SELECT (SELECT count(*) FROM likes
                WHERE liked_id = $1 AND action = 'like')      AS "likedYou",
              (SELECT count(*) FROM matches
                WHERE (user_a = $1 OR user_b = $1)
                  AND closed_at IS NULL)                      AS matches`,
      [req.userId],
    );

    return { ...me, stats };
  });

  fastify.patch('/me', async req => {
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        city: z.string().max(120).optional(),
        bio: z.string().max(1000).optional(),
        isDiscoverable: z.boolean().optional(),
        isInvisible: z.boolean().optional(),
        notifyAll: z.boolean().optional(),
        notifyNewMatch: z.boolean().optional(),
        interests: z.array(z.string().max(40)).max(20).optional(),
      })
      .parse(req.body);

    await transaction(async client => {
      // COALESCE keeps every unspecified field untouched, so this is a real
      // partial update rather than an overwrite with nulls.
      await query(
        `UPDATE users SET
           name             = COALESCE($2, name),
           city             = COALESCE($3, city),
           bio              = COALESCE($4, bio),
           is_discoverable  = COALESCE($5, is_discoverable),
           is_invisible     = COALESCE($6, is_invisible),
           notify_all       = COALESCE($7, notify_all),
           notify_new_match = COALESCE($8, notify_new_match)
         WHERE id = $1`,
        [
          req.userId,
          body.name ?? null,
          body.city ?? null,
          body.bio ?? null,
          body.isDiscoverable ?? null,
          body.isInvisible ?? null,
          body.notifyAll ?? null,
          body.notifyNewMatch ?? null,
        ],
        client,
      );

      if (body.interests) {
        await query('DELETE FROM user_interests WHERE user_id = $1', [req.userId], client);
        if (body.interests.length) {
          await query(
            `INSERT INTO user_interests (user_id, interest_id)
             SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
            [req.userId, body.interests],
            client,
          );
        }
      }
    });

    return { ok: true };
  });

  fastify.get('/:userId', async req => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);

    // A blocked user must be indistinguishable from one who does not exist.
    const blocked = await queryOne(
      `SELECT 1 FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = $2)
           OR (blocker_id = $2 AND blocked_id = $1)`,
      [req.userId, userId],
    );
    if (blocked) throw notFound('User not found');

    const profile = await queryOne(publicProfile, [userId]);
    if (!profile) throw notFound('User not found');
    return profile;
  });

  // "Take a break" — reversible; signing back in reactivates.
  fastify.post('/me/deactivate', async (req, reply) => {
    await query("UPDATE users SET status = 'deactivated' WHERE id = $1", [req.userId]);
    await revokeAllRefreshTokens(req.userId!);
    return reply.status(204).send();
  });

  fastify.delete('/me', async (req, reply) => {
    // Soft delete keeps the id referentially valid for a later out-of-band
    // purge, while stripping personal data immediately.
    await transaction(async client => {
      await query(
        `UPDATE users
            SET status = 'deleted',
                deleted_at = now(),
                email = concat('deleted+', id, '@invalid'),
                password_hash = NULL,
                name = 'Deleted user',
                bio = NULL, phone = NULL, city = NULL
          WHERE id = $1`,
        [req.userId],
        client,
      );
      await query('DELETE FROM moments WHERE user_id = $1', [req.userId], client);
      // Queue every image for CDN removal before dropping the rows, or the
      // photos stay live on Cloudinary after the account is gone.
      await query(
        `INSERT INTO pending_media_deletions (public_id)
         SELECT public_id FROM user_photos
          WHERE user_id = $1 AND public_id IS NOT NULL`,
        [req.userId],
        client,
      );
      await query('DELETE FROM user_photos WHERE user_id = $1', [req.userId], client);
      await query(
        `UPDATE matches SET closed_at = now()
          WHERE user_a = $1 OR user_b = $1`,
        [req.userId],
        client,
      );
    });

    await revokeAllRefreshTokens(req.userId!);
    return reply.status(204).send();
  });
}
