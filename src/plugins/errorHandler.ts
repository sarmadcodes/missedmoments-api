import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';
import { isProd } from '../config.js';

/**
 * Single place that turns a thrown error into a response body.
 *
 * Unexpected errors are logged in full but returned as a generic message, so
 * internals (SQL, stack traces) never reach a client.
 */
export default fp(async fastify => {
  fastify.setErrorHandler((err: unknown, req, reply) => {
    const fastifyErr = err as {
      validation?: unknown;
      statusCode?: number;
      message?: string;
    };
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ code: err.code, message: err.message });
    }

    if (err instanceof ZodError) {
      return reply.status(400).send({
        code: 'VALIDATION_FAILED',
        message: 'Some fields are invalid',
        fields: err.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    if (fastifyErr.validation) {
      return reply
        .status(400)
        .send({ code: 'VALIDATION_FAILED', message: fastifyErr.message });
    }

    if (fastifyErr.statusCode === 429) {
      return reply
        .status(429)
        .send({ code: 'RATE_LIMITED', message: 'Too many requests' });
    }

    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      code: 'INTERNAL_ERROR',
      message: isProd ? 'Something went wrong' : String(fastifyErr.message ?? err),
    });
  });

  fastify.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ code: 'NOT_FOUND', message: 'No such endpoint' });
  });
});
