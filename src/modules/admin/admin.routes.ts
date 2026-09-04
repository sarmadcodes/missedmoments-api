import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne, transaction } from '../../lib/db.js';
import { unauthorized, notFound, badRequest } from '../../lib/errors.js';
import { signAccessToken } from '../../lib/tokens.js';
import { destroyAsset } from '../../lib/cloudinary.js';
import argon2 from 'argon2';

/**
 * The minimal admin surface this launch needs: user lookup/suspend/ban,
 * report review, and a photo moderation queue. Deliberately not a roles/
 * permissions system -- `is_admin` is a single boolean, and every route here
 * requires it. See src/plugins/auth.ts for how that is enforced.
 */
export default async function adminRoutes(fastify: FastifyInstance) {
  // Admin login is separate from the app's /v1/auth/login so a normal user's
  // token (even if somehow guessed to be an admin's) still has to pass the
  // same password check here -- this route is the only place that hands out
  // a token that authenticateAdmin will accept, and only to accounts already
  // flagged is_admin in the database.
  fastify.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async req => {
      const body = z
        .object({ email: z.string().email(), password: z.string().min(1) })
        .parse(req.body);

      const user = await queryOne<{
        id: string;
        password_hash: string | null;
        is_admin: boolean;
        status: string;
      }>('SELECT id, password_hash, is_admin, status FROM users WHERE email = $1', [
        body.email,
      ]);

      const hash =
        user?.password_hash ??
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';

      let ok = false;
      try {
        ok = await argon2.verify(hash, body.password);
      } catch {
        ok = false;
      }

      if (!user || !ok || !user.is_admin || user.status !== 'active') {
        throw unauthorized('Incorrect email or password');
      }

      return { accessToken: await signAccessToken(user.id) };
    },
  );

  fastify.register(async admin => {
    admin.addHook('onRequest', fastify.authenticateAdmin);

    // ---------------------------------------------------------- dashboard
    admin.get('/stats', async () => {
      const [users, active, reportsOpen, matches, pendingPhotos] = await Promise.all([
        queryOne<{ count: number }>("SELECT count(*)::int AS count FROM users WHERE status <> 'deleted'"),
        queryOne<{ count: number }>(
          "SELECT count(*)::int AS count FROM users WHERE status = 'active'",
        ),
        queryOne<{ count: number }>(
          "SELECT count(*)::int AS count FROM reports WHERE status = 'open'",
        ),
        queryOne<{ count: number }>(
          'SELECT count(*)::int AS count FROM matches WHERE closed_at IS NULL',
        ),
        queryOne<{ count: number }>(
          "SELECT count(*)::int AS count FROM user_photos WHERE moderation = 'pending'",
        ),
      ]);

      return {
        totalUsers: users?.count ?? 0,
        activeUsers: active?.count ?? 0,
        openReports: reportsOpen?.count ?? 0,
        activeMatches: matches?.count ?? 0,
        pendingPhotos: pendingPhotos?.count ?? 0,
      };
    });

    // -------------------------------------------------------------- users
    admin.get('/users', async req => {
      const { q, limit } = z
        .object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
        .parse(req.query);

      const rows = q
        ? await query(
            `SELECT id AS "userId", email, name, status, is_admin AS "isAdmin",
                    created_at AS "joinedAt"
               FROM users
              WHERE email ILIKE $1 OR name ILIKE $1
              ORDER BY created_at DESC LIMIT $2`,
            [`%${q}%`, limit],
          )
        : await query(
            `SELECT id AS "userId", email, name, status, is_admin AS "isAdmin",
                    created_at AS "joinedAt"
               FROM users
              ORDER BY created_at DESC LIMIT $1`,
            [limit],
          );

      return { users: rows };
    });

    admin.get('/users/:id', async req => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const user = await queryOne(
        `SELECT id AS "userId", email, name, status, is_admin AS "isAdmin",
                user_age(birth_date) AS age, city, bio, created_at AS "joinedAt"
           FROM users WHERE id = $1`,
        [id],
      );
      if (!user) throw notFound('User not found');

      const [reportsAgainst, reportsBy, photos] = await Promise.all([
        query(
          `SELECT id, reason, detail, status, created_at AS "createdAt"
             FROM reports WHERE reported_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [id],
        ),
        query(
          `SELECT id, reported_id AS "reportedId", reason, status, created_at AS "createdAt"
             FROM reports WHERE reporter_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [id],
        ),
        query(
          `SELECT id, url, moderation, is_primary AS "isPrimary"
             FROM user_photos WHERE user_id = $1 ORDER BY position`,
          [id],
        ),
      ]);

      return { ...user, reportsAgainst, reportsBy, photos };
    });

    const setStatus = (status: 'suspended' | 'banned' | 'active') =>
      async (req: any, reply: any) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const target = await queryOne<{ is_admin: boolean }>(
          'SELECT is_admin FROM users WHERE id = $1',
          [id],
        );
        if (!target) throw notFound('User not found');
        if (target.is_admin) {
          throw badRequest('CANNOT_ACTION_ADMIN', 'Cannot suspend/ban another admin');
        }

        await query('UPDATE users SET status = $2 WHERE id = $1', [id, status]);
        return reply.status(204).send();
      };

    admin.post('/users/:id/suspend', setStatus('suspended'));
    admin.post('/users/:id/ban', setStatus('banned'));
    admin.post('/users/:id/restore', setStatus('active'));

    // ------------------------------------------------------------ reports
    admin.get('/reports', async req => {
      const { status } = z
        .object({ status: z.enum(['open', 'reviewing', 'actioned', 'dismissed']).default('open') })
        .parse(req.query);

      const rows = await query(
        `SELECT r.id, r.reason, r.detail, r.status, r.created_at AS "createdAt",
                reporter.id AS "reporterId", reporter.name AS "reporterName",
                reported.id AS "reportedId", reported.name AS "reportedName",
                reported.status AS "reportedStatus"
           FROM reports r
           JOIN users reporter ON reporter.id = r.reporter_id
           JOIN users reported ON reported.id = r.reported_id
          WHERE r.status = $1
          ORDER BY r.created_at ASC`,
        [status],
      );

      return { reports: rows };
    });

    const resolveReport = (status: 'actioned' | 'dismissed') =>
      async (req: any, reply: any) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const updated = await queryOne(
          `UPDATE reports SET status = $2, resolved_by = $3, resolved_at = now()
             WHERE id = $1 RETURNING id`,
          [id, status, req.userId],
        );
        if (!updated) throw notFound('Report not found');
        return reply.status(204).send();
      };

    admin.post('/reports/:id/resolve', resolveReport('actioned'));
    admin.post('/reports/:id/dismiss', resolveReport('dismissed'));

    // ------------------------------------------------------------- photos
    admin.get('/photos/pending', async () => ({
      photos: await query(
        `SELECT p.id, p.url, p.created_at AS "createdAt",
                u.id AS "userId", u.name AS "userName", u.email AS "userEmail"
           FROM user_photos p
           JOIN users u ON u.id = p.user_id
          WHERE p.moderation = 'pending'
          ORDER BY p.created_at ASC
          LIMIT 100`,
      ),
    }));

    admin.post('/photos/:id/approve', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const updated = await queryOne(
        `UPDATE user_photos
            SET moderation = 'approved', moderated_by = $2, moderated_at = now()
          WHERE id = $1 RETURNING id`,
        [id, req.userId],
      );
      if (!updated) throw notFound('Photo not found');
      return reply.status(204).send();
    });

    admin.post('/photos/:id/reject', async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

      // Rejecting removes the photo outright rather than leaving a rejected
      // row lying around -- there is no "appeal" flow for this launch, and a
      // rejected image should not keep occupying a photo slot silently.
      const photo = await transaction(async client => {
        const row = await queryOne<{ public_id: string | null; is_primary: boolean }>(
          'SELECT public_id, is_primary FROM user_photos WHERE id = $1',
          [id],
          client,
        );
        if (!row) throw notFound('Photo not found');

        await query('DELETE FROM user_photos WHERE id = $1', [id], client);

        if (row.public_id) {
          await query(
            'INSERT INTO pending_media_deletions (public_id) VALUES ($1)',
            [row.public_id],
            client,
          );
        }
        return row;
      });

      if (photo.public_id) {
        destroyAsset(photo.public_id).catch(err =>
          req.log.warn({ err }, 'cloudinary delete failed after photo rejection'),
        );
      }

      return reply.status(204).send();
    });
  });
}
