import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as service from './likes.service.js';
import { sendPushToUser } from '../../lib/push.js';

export default async function likeRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/', async req => {
    const body = z
      .object({
        targetUserId: z.string().uuid(),
        action: z.enum(['like', 'pass']),
        momentId: z.string().uuid().optional(),
      })
      .parse(req.body);

    const result = await service.likeUser(
      req.userId!,
      body.targetUserId,
      body.action,
      body.momentId,
    );

    // Fired after the transaction has already committed, never awaited by
    // the response: a push provider being slow or down must not add latency
    // to (or ever be able to fail) the like/match itself.
    if (result.matched && result.matchId) {
      const data = { type: 'match', matchId: result.matchId };
      void sendPushToUser(req.userId!, {
        title: 'New match',
        body: 'You have a new match',
        data,
      });
      void sendPushToUser(body.targetUserId, {
        title: 'New match',
        body: 'You have a new match',
        data,
      });
    } else if (body.action === 'like') {
      // Anonymous by design: no title/body/data here ever names the liker,
      // matching the exact same rule the in-app notification feed enforces.
      void sendPushToUser(body.targetUserId, {
        title: 'New like',
        body: 'Someone liked your moment',
        data: { type: 'like' },
      });
    }

    return result;
  });

  fastify.get('/admirers', async req => ({
    people: await service.listAdmirers(req.userId!),
  }));

  fastify.get('/matches', async req => ({
    matches: await service.listMatches(req.userId!),
  }));
}
