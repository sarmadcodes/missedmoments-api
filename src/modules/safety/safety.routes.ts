import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, transaction } from '../../lib/db.js';

export default async function safetyRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/blocks', async req => ({
    blocked: await query(
      `SELECT u.id AS "userId", u.name, p.url AS "photoUrl",
              b.created_at AS "blockedAt"
         FROM blocks b
         JOIN users u ON u.id = b.blocked_id
         LEFT JOIN user_photos p ON p.user_id = u.id AND p.is_primary
        WHERE b.blocker_id = $1
        ORDER BY b.created_at DESC`,
      [req.userId],
    ),
  }));

  fastify.post('/blocks', async (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);

    await transaction(async client => {
      await query(
        `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.userId, userId],
        client,
      );
      // Blocking closes any open conversation in both directions.
      await query(
        `UPDATE matches SET closed_at = now()
          WHERE closed_at IS NULL
            AND ((user_a = $1 AND user_b = $2)
              OR (user_a = $2 AND user_b = $1))`,
        [req.userId, userId],
        client,
      );
    });

    return reply.status(204).send();
  });

  fastify.delete('/blocks/:userId', async (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    await query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [
      req.userId,
      userId,
    ]);
    return reply.status(204).send();
  });

  fastify.post('/reports', async (req, reply) => {
    const body = z
      .object({
        userId: z.string().uuid(),
        reason: z.string().min(1).max(80),
        detail: z.string().max(2000).optional(),
      })
      .parse(req.body);

    await query(
      `INSERT INTO reports (reporter_id, reported_id, reason, detail)
       VALUES ($1, $2, $3, $4)`,
      [req.userId, body.userId, body.reason, body.detail ?? null],
    );

    return reply.status(201).send({ ok: true });
  });

  fastify.post('/feedback', async (req, reply) => {
    const body = z
      .object({
        reason: z.string().min(1).max(80),
        message: z.string().max(2000).optional(),
      })
      .parse(req.body);

    await query(
      'INSERT INTO feedback (user_id, reason, message) VALUES ($1, $2, $3)',
      [req.userId, body.reason, body.message ?? null],
    );

    return reply.status(201).send({ ok: true });
  });
}
