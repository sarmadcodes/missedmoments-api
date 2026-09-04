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

  // Cloudinary. Uploads are signed server-side, so the secret never leaves
  // this process and the app only ever receives a short-lived signature.
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  // No automated moderation provider is wired up, so the safe default holds
  // every new photo for admin review before anyone else can see it. This is
  // a dating app; publishing unmoderated photos by default is not an
  // acceptable launch posture. Set true only once auto-moderation exists.
  // NOT z.coerce.boolean(): that coerces via JS's Boolean(), so the STRING
  // "false" (any non-empty string) parses to `true`. Confirmed by direct
  // test -- PHOTO_AUTO_APPROVE=false in .env was silently being read as
  // true. This is a real footgun with z.coerce.boolean() on any env var.
  PHOTO_AUTO_APPROVE: z
    .string()
    .default('false')
    .transform(v => v.toLowerCase() === 'true'),

  MOMENT_RADIUS_METRES: z.coerce.number().int().positive().default(150),
  MOMENT_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),

  // The one-off script that grants admin access checks this before writing
  // is_admin=true, so a leaked DB URL alone cannot be used to self-promote.
  ADMIN_BOOTSTRAP_KEY: z.string().default(''),

  // Push notifications (Android + iOS, both through Firebase Cloud Messaging
  // -- FCM delivers to APNs on Firebase's behalf for iOS, so one service
  // account covers both platforms; no separate APNs key/cert is needed on
  // the backend). The whole service account JSON from the Firebase console
  // (Project settings -> Service accounts -> Generate new private key),
  // pasted as a single-line string. Empty means push is simply not
  // attempted -- see lib/push.ts.
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().default(''),
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
