import Redis from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('error', err => {
  // Logged rather than thrown: the API degrades (no cache, no presence) but
  // must not crash because Redis blipped.
  console.error('[redis]', err.message);
});
