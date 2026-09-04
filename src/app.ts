import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { config, isProd } from './config.js';
import { redis } from './lib/redis.js';
import { pool } from './lib/db.js';
import authPlugin from './plugins/auth.js';
import errorHandler from './plugins/errorHandler.js';

import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/users/users.routes.js';
import momentRoutes from './modules/moments/moments.routes.js';
import likeRoutes from './modules/likes/likes.routes.js';
import chatRoutes from './modules/chat/chat.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import safetyRoutes from './modules/safety/safety.routes.js';
import mediaRoutes from './modules/media/media.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const buildApp = async () => {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never log credentials or tokens, even at debug level.
      redact: ['req.headers.authorization', 'req.body.password', 'req.body.newPassword'],
      transport: isProd ? undefined : { target: 'pino-pretty' },
    },
    trustProxy: isProd,
    bodyLimit: 1_048_576, // 1 MiB
  });

  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(cors, {
    // The mobile app sends no Origin; a browser-based admin panel would need
    // an explicit allowlist here.
    origin: isProd ? [] : true,
    credentials: true,
  });

  // Global ceiling. Individual routes tighten this via `config.rateLimit`.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    redis,
    keyGenerator: req => req.userId ?? req.ip,
  });

  await app.register(websocket);
  await app.register(errorHandler);
  await app.register(authPlugin);

  app.get('/health', async () => {
    const [db, cache] = await Promise.allSettled([
      pool.query('SELECT 1'),
      redis.ping(),
    ]);
    const healthy = db.status === 'fulfilled' && cache.status === 'fulfilled';
    return {
      status: healthy ? 'ok' : 'degraded',
      db: db.status === 'fulfilled',
      redis: cache.status === 'fulfilled',
    };
  });

  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(userRoutes, { prefix: '/v1/users' });
  await app.register(momentRoutes, { prefix: '/v1/moments' });
  await app.register(likeRoutes, { prefix: '/v1/likes' });
  await app.register(chatRoutes, { prefix: '/v1/chat' });
  await app.register(notificationRoutes, { prefix: '/v1/notifications' });
  await app.register(safetyRoutes, { prefix: '/v1/safety' });
  await app.register(mediaRoutes, { prefix: '/v1/media' });
  await app.register(adminRoutes, { prefix: '/v1/admin' });

  // The admin UI is a single static page served same-origin as its own API,
  // so it needs no CORS entry and no separate deploy. Read once at boot
  // rather than per-request; it never changes at runtime.
  //
  // The file lives in a top-level admin/ folder (not under src/) because
  // `tsc` does not copy non-TypeScript assets into dist/. __dirname is
  // <project>/src when running via tsx and <project>/dist when running the
  // compiled build, so going up one level reaches the project root in both.
  const adminHtml = await readFile(
    path.join(__dirname, '..', 'admin', 'admin-page.html'),
    'utf8',
  );
  app.get('/admin', async (_req, reply) => {
    reply.type('text/html').send(adminHtml);
  });

  return app;
};
