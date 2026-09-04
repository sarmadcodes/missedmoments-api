import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../lib/db.js';

export default async function notificationRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async req => ({
    notifications: await query(
      // A one-sided like is anonymous by design: that is the whole product.
      // The actor is kept on the row (a match later needs it) but must never
      // be revealed here, or the notification feed unmasks Quiet Admirers.
      `SELECT n.id, n.kind, n.body,
              n.created_at AS "createdAt",
              n.read_at    AS "readAt",
              CASE WHEN n.kind = 'like' THEN NULL ELSE a.name END
                           AS "actorName",
              CASE WHEN n.kind = 'like' THEN NULL ELSE p.url END
                           AS "actorPhotoUrl"
         FROM notifications n
         LEFT JOIN users a ON a.id = n.actor_id AND a.status = 'active'
         LEFT JOIN user_photos p ON p.user_id = a.id AND p.is_primary
        WHERE n.user_id = $1
        ORDER BY n.created_at DESC
        LIMIT 100`,
      [req.userId],
    ),
  }));

  fastify.post('/read', async (req, reply) => {
    await query(
      `UPDATE notifications SET read_at = now()
        WHERE user_id = $1 AND read_at IS NULL`,
      [req.userId],
    );
    return reply.status(204).send();
  });

  // Push registration. `token` is unique, so re-registering the same device on
  // a different account moves it rather than duplicating it.
  fastify.post('/devices', async (req, reply) => {
    const body = z
      .object({
        token: z.string().min(1).max(500),
        platform: z.enum(['ios', 'android']),
      })
      .parse(req.body);

    await query(
      `INSERT INTO device_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [req.userId, body.token, body.platform],
    );

    return reply.status(204).send();
  });

  // Called on sign-out so a shared or reset device stops receiving this
  // account's pushes once nobody is signed into it as this user anymore.
  fastify.delete('/devices/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(1).max(500) }).parse(req.params);
    await query('DELETE FROM device_tokens WHERE token = $1 AND user_id = $2', [
      token,
      req.userId,
    ]);
    return reply.status(204).send();
  });
}
