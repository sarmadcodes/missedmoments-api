import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../lib/tokens.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { queryOne } from '../lib/db.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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

  /**
   * Same access token as a normal user, but is_admin is re-checked against
   * the database on every request rather than trusted from the JWT. A JWT
   * claim would keep working for up to ACCESS_TOKEN_TTL after an admin's
   * access is revoked; this check makes revocation immediate.
   */
  fastify.decorate('authenticateAdmin', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized('Missing bearer token');
    }
    const claims = await verifyAccessToken(header.slice(7));

    const user = await queryOne<{ is_admin: boolean; status: string }>(
      'SELECT is_admin, status FROM users WHERE id = $1',
      [claims.sub],
    );

    if (!user?.is_admin || user.status !== 'active') {
      throw forbidden('Admin access required');
    }

    req.userId = claims.sub;
  });
});
