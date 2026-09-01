import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as service from './moments.service.js';

const checkInBody = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional(),
  capturedAt: z.string().datetime().optional(),
});

export default async function momentRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post(
    '/check-in',
    // A check-in hits Google Places; cap it well below what a UI would ever do.
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async req => {
      const body = checkInBody.parse(req.body);
      const moment = await service.checkIn(req.userId!, body);
      const nearby = await service.findNearby(req.userId!, 'hour');
      return { moment, nearby };
    },
  );

  fastify.get('/nearby', async req => {
    const { window } = z
      .object({ window: z.enum(['hour', 'today', 'week']).default('hour') })
      .parse(req.query);

    const people = await service.findNearby(req.userId!, window);
    return { window, count: people.length, people };
  });
}
