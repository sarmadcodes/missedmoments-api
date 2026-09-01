import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { query, queryOne, transaction } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import {
  createUploadTicket,
  verifyAsset,
  destroyAsset,
  isConfigured,
} from '../../lib/cloudinary.js';

const MAX_PHOTOS = 6;

export default async function mediaRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  /**
   * Step 1 of an upload: hand the app a short-lived signature.
   *
   * Rate limited well below anything a person could do by hand, because each
   * ticket is permission to write into our Cloudinary account.
   */
  fastify.post(
    '/upload-ticket',
    { config: { rateLimit: { max: 40, timeWindow: '1 hour' } } },
    async req => {
      const count = await queryOne<{ count: number }>(
        'SELECT count(*)::int AS count FROM user_photos WHERE user_id = $1',
        [req.userId],
      );

      if ((count?.count ?? 0) >= MAX_PHOTOS) {
        throw badRequest(
          'PHOTO_LIMIT',
          `You can have at most ${MAX_PHOTOS} photos. Remove one first.`,
        );
      }

      return createUploadTicket(req.userId!);
    },
  );

  /**
   * Step 2: the app reports what it uploaded.
   *
   * The asset is verified against Cloudinary before it is trusted -- the
   * client supplies the public_id, so without this check a caller could claim
   * an asset it does not own, or one that was never uploaded at all.
   */
  fastify.post('/photos', async (req, reply) => {
    const body = z
      .object({
        publicId: z.string().min(1).max(300),
        isPrimary: z.boolean().optional(),
      })
      .parse(req.body);

    const asset = await verifyAsset(body.publicId, req.userId!);

    const photo = await transaction(async client => {
      const existing = await queryOne<{ count: number }>(
        'SELECT count(*)::int AS count FROM user_photos WHERE user_id = $1',
        [req.userId],
        client,
      );

      const count = existing?.count ?? 0;
      if (count >= MAX_PHOTOS) {
        throw badRequest('PHOTO_LIMIT', `You can have at most ${MAX_PHOTOS} photos.`);
      }

      // First photo becomes the avatar automatically; there is no sensible
      // alternative and it saves a second round trip on signup.
      const makePrimary = body.isPrimary ?? count === 0;

      if (makePrimary) {
        await query(
          'UPDATE user_photos SET is_primary = FALSE WHERE user_id = $1',
          [req.userId],
          client,
        );
      }

      return queryOne<{ id: string }>(
        `INSERT INTO user_photos
           (user_id, url, public_id, width, height, bytes, position,
            is_primary, moderation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          req.userId,
          asset.url,
          body.publicId,
          asset.width,
          asset.height,
          asset.bytes,
          count,
          makePrimary,
          config.PHOTO_AUTO_APPROVE ? 'approved' : 'pending',
        ],
        client,
      );
    });

    return reply.status(201).send({
      id: photo!.id,
      url: asset.url,
      publicId: body.publicId,
      moderation: config.PHOTO_AUTO_APPROVE ? 'approved' : 'pending',
    });
  });

  fastify.get('/photos', async req => ({
    photos: await query(
      `SELECT id, url, public_id AS "publicId", position,
              is_primary AS "isPrimary", moderation
         FROM user_photos
        WHERE user_id = $1
        ORDER BY is_primary DESC, position ASC`,
      [req.userId],
    ),
  }));

  fastify.patch('/photos/:id/primary', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    await transaction(async client => {
      const owned = await queryOne(
        'SELECT 1 FROM user_photos WHERE id = $1 AND user_id = $2',
        [id, req.userId],
        client,
      );
      if (!owned) throw notFound('Photo not found');

      await query(
        'UPDATE user_photos SET is_primary = FALSE WHERE user_id = $1',
        [req.userId],
        client,
      );
      await query('UPDATE user_photos SET is_primary = TRUE WHERE id = $1', [id], client);
    });

    return reply.status(204).send();
  });

  fastify.delete('/photos/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const photo = await queryOne<{ public_id: string | null; is_primary: boolean }>(
      'SELECT public_id, is_primary FROM user_photos WHERE id = $1 AND user_id = $2',
      [id, req.userId],
    );
    if (!photo) throw notFound('Photo not found');

    await transaction(async client => {
      await query('DELETE FROM user_photos WHERE id = $1', [id], client);

      // Queue the CDN delete rather than doing it inline: a Cloudinary outage
      // must not stop someone removing a photo from their profile.
      if (photo.public_id) {
        await query(
          'INSERT INTO pending_media_deletions (public_id) VALUES ($1)',
          [photo.public_id],
          client,
        );
      }

      // Promote another photo so the profile is not left without an avatar.
      if (photo.is_primary) {
        await query(
          `UPDATE user_photos SET is_primary = TRUE
            WHERE id = (SELECT id FROM user_photos
                         WHERE user_id = $1
                         ORDER BY position ASC LIMIT 1)`,
          [req.userId],
          client,
        );
      }
    });

    // Best effort, immediately; the queue is the fallback.
    if (photo.public_id) {
      destroyAsset(photo.public_id)
        .then(ok => {
          if (ok) {
            return query(
              `UPDATE pending_media_deletions SET deleted_at = now()
                WHERE public_id = $1 AND deleted_at IS NULL`,
              [photo.public_id],
            );
          }
          return undefined;
        })
        .catch(err => req.log.warn({ err }, 'cloudinary delete failed; queued'));
    }

    return reply.status(204).send();
  });

  // Lets the app tell the user why uploading is unavailable instead of
  // failing with a generic error.
  fastify.get('/status', async () => ({ uploadsEnabled: isConfigured() }));
}
