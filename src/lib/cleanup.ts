import { query } from './db.js';
import { purgeExpiredMoments } from '../modules/moments/moments.service.js';
import { destroyAsset, isConfigured } from './cloudinary.js';

/**
 * Retries CDN deletions that did not go through at delete time.
 *
 * DELETE /v1/media/photos and the admin photo-reject route both fire
 * destroyAsset() immediately without awaiting it, so a slow or briefly-down
 * Cloudinary never blocks a user removing their own photo. pending_media_
 * deletions is the record of that request; this is what actually retries the
 * ones that failed, so an outage doesn't mean an image stays live forever.
 */
const retryPendingMediaDeletions = async () => {
  if (!isConfigured()) return 0;

  const rows = await query<{ id: string; public_id: string }>(
    `SELECT id, public_id FROM pending_media_deletions
      WHERE deleted_at IS NULL AND attempts < 5
      ORDER BY requested_at ASC
      LIMIT 50`,
  );

  let cleaned = 0;
  for (const row of rows) {
    try {
      const ok = await destroyAsset(row.public_id);
      if (ok) {
        await query(
          'UPDATE pending_media_deletions SET deleted_at = now() WHERE id = $1',
          [row.id],
        );
        cleaned += 1;
      } else {
        await query(
          `UPDATE pending_media_deletions
              SET attempts = attempts + 1, last_error = 'destroy returned not-ok'
            WHERE id = $1`,
          [row.id],
        );
      }
    } catch (err) {
      await query(
        `UPDATE pending_media_deletions
            SET attempts = attempts + 1, last_error = $2
          WHERE id = $1`,
        [row.id, err instanceof Error ? err.message : String(err)],
      );
    }
  }
  return cleaned;
};

/** One pass of everything this job is responsible for. Exported for the test. */
export const runCleanupOnce = async (log: { info: (o: unknown, msg?: string) => void }) => {
  const [expiredMoments, cleanedMedia] = await Promise.all([
    purgeExpiredMoments(),
    retryPendingMediaDeletions(),
  ]);

  if (expiredMoments || cleanedMedia) {
    log.info({ expiredMoments, cleanedMedia }, 'cleanup pass');
  }

  return { expiredMoments, cleanedMedia };
};

/**
 * Runs the cleanup pass on an interval, in-process. No new infrastructure
 * (no separate worker, no queue system, no node-cron dependency) -- this is
 * one API instance's job, guarded against overlap so a slow pass can never
 * stack with the next tick and run twice at once.
 *
 * If more than one API instance is ever run behind a load balancer, this
 * still works correctly: purgeExpiredMoments and the media retry are both
 * plain idempotent DELETE/UPDATE statements, so two instances racing the same
 * pass just do some redundant no-op work, never double-delete or corrupt
 * state. Worth moving to a single dedicated worker before that matters for
 * cost reasons, not correctness ones.
 */
export const startCleanupSchedule = (
  log: { info: (o: unknown, msg?: string) => void; error: (o: unknown, msg?: string) => void },
  intervalMs = 15 * 60 * 1000,
) => {
  let running = false;

  const tick = async () => {
    if (running) return; // overlap guard
    running = true;
    try {
      await runCleanupOnce(log);
    } catch (err) {
      log.error({ err }, 'cleanup pass failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Unref so this timer alone never keeps the process alive past shutdown.
  timer.unref?.();

  // Run once shortly after boot too, rather than waiting a full interval.
  setTimeout(tick, 10_000);

  return () => clearInterval(timer);
};
