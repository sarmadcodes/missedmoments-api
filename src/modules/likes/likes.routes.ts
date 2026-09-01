import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as service from './likes.service.js';

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

    return service.likeUser(
      req.userId!,
      body.targetUserId,
      body.action,
      body.momentId,
    );
  });

  fastify.get('/admirers', async req => ({
    people: await service.listAdmirers(req.userId!),
  }));

  fastify.get('/matches', async req => ({
    matches: await service.listMatches(req.userId!),
  }));
}
