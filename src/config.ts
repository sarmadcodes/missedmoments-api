import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is validated once at boot. A missing or malformed value fails
 * the process immediately rather than surfacing as a confusing runtime error
 * hours later.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  GOOGLE_MAPS_API_KEY: z.string().default(''),

  MOMENT_RADIUS_METRES: z.coerce.number().int().positive().default(150),
  MOMENT_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
