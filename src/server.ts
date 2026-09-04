import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './lib/db.js';
import { redis } from './lib/redis.js';
import { startCleanupSchedule } from './lib/cleanup.js';

const start = async () => {
  const app = await buildApp();

  // Expired moments and any Cloudinary delete that failed at request time
  // both need a place to actually get cleaned up. See lib/cleanup.ts.
  const stopCleanup = startCleanupSchedule(app.log);

  // Drain in-flight requests before dropping connections, so a deploy does not
  // cut anyone off mid-request.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      stopCleanup();
      await app.close();
      await pool.end();
      redis.disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', err => {
    app.log.error({ err }, 'unhandled rejection');
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
};

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
