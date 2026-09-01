-- Photos are stored in Cloudinary; we keep the identifiers needed to render
-- and to delete them.
--
-- `public_id` is Cloudinary's handle for the asset. Without it a deleted
-- account leaves its images live on the CDN forever, which is both a cost and
-- a privacy problem, so it is required for anything uploaded from now on.

ALTER TABLE user_photos
  ADD COLUMN IF NOT EXISTS public_id TEXT,
  ADD COLUMN IF NOT EXISTS width     INT,
  ADD COLUMN IF NOT EXISTS height    INT,
  ADD COLUMN IF NOT EXISTS bytes     INT;

-- One row per Cloudinary asset.
CREATE UNIQUE INDEX IF NOT EXISTS user_photos_public_id_key
  ON user_photos (public_id) WHERE public_id IS NOT NULL;

-- Deleting a user must leave a trail of what still needs removing from the
-- CDN, since that happens out of band rather than inside the request.
CREATE TABLE IF NOT EXISTS pending_media_deletions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id   TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT
);

CREATE INDEX IF NOT EXISTS pending_media_deletions_open_idx
  ON pending_media_deletions (requested_at)
  WHERE deleted_at IS NULL;
