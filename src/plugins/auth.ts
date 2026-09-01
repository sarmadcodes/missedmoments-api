import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../lib/tokens.js';
import { unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Adds `fastify.authenticate`, used as an onRequest hook on protected routes.
 * Nothing is authenticated implicitly — a route without it is public by
 * intent, not by accident.
 */
export default fp(async fastify => {
  fastify.decorateRequest('userId', undefined);

  fastify.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized('Missing bearer token');
    }
    const claims = await verifyAccessToken(header.slice(7));
    req.userId = claims.sub;
  });
});
