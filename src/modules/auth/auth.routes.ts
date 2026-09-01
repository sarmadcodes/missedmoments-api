import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as service from './auth.service.js';
import { rotateRefreshToken, revokeAllRefreshTokens } from '../../lib/tokens.js';

// Passwords: length beats composition rules. 8 is the floor, 72 is bcrypt/argon
// practical input limit territory and stops absurd payloads.
const password = z.string().min(8, 'Use at least 8 characters').max(200);

const registerBody = z.object({
  email: z.string().email().max(255),
  password,
  name: z.string().min(1).max(80),
  birthDate: z.string().date().optional(),
  gender: z.string().max(40).optional(),
  city: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
  bio: z.string().max(1000).optional(),
  interests: z.array(z.string().max(40)).max(20).optional(),
});

const loginBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

export default async function authRoutes(fastify: FastifyInstance) {
  // Auth endpoints get their own tighter limit; these are the ones worth
  // brute-forcing.
  const strictLimit = {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  };

  fastify.post('/register', strictLimit, async (req, reply) => {
    const body = registerBody.parse(req.body);

    if (body.birthDate) {
      const age =
        (Date.now() - new Date(body.birthDate).getTime()) / (365.25 * 864e5);
      if (age < 18) {
        return reply
          .status(400)
          .send({ code: 'UNDERAGE', message: 'You must be 18 or older' });
      }
    }

    const result = await service.register(body);
    return reply.status(201).send(result);
  });

  fastify.post('/login', strictLimit, async req => {
    const body = loginBody.parse(req.body);
    return service.login(body.email, body.password);
  });

  fastify.post('/refresh', async req => {
    const { refreshToken } = z
      .object({ refreshToken: z.string().min(1) })
      .parse(req.body);
    const { accessToken, refreshToken: next } = await rotateRefreshToken(refreshToken);
    return { accessToken, refreshToken: next };
  });

  fastify.post(
    '/logout',
    { onRequest: [fastify.authenticate] },
    async (req, reply) => {
      await revokeAllRefreshTokens(req.userId!);
      return reply.status(204).send();
    },
  );

  fastify.post(
    '/change-password',
    { onRequest: [fastify.authenticate], ...strictLimit },
    async (req, reply) => {
      const body = z
        .object({ currentPassword: z.string().min(1), newPassword: password })
        .parse(req.body);

      await service.changePassword(
        req.userId!,
        body.currentPassword,
        body.newPassword,
      );
      // Changing a password invalidates every other session.
      await revokeAllRefreshTokens(req.userId!);
      return reply.status(204).send();
    },
  );
}
