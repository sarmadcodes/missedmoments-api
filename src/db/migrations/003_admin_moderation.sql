-- Minimal admin/moderation support for launch.
--
-- Deliberately small: one boolean flag for admin access (not a roles table),
-- two new lifecycle states so moderation actions are distinguishable from a
-- user's own deactivate/delete, and enough columns to show who actioned what.
-- No new tables beyond what already exists (reports, user_photos) except the
-- audit trail, which a moderation feature needs to be trustworthy at all.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- 'suspended' = temporary, admin-reversible. 'banned' = admin-only, permanent
-- intent. Both are distinct from 'deactivated' (user's own "take a break")
-- and 'deleted' (user's own account deletion), so support can tell at a
-- glance whether a user left or was removed.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'deactivated', 'deleted', 'suspended', 'banned'));

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

ALTER TABLE user_photos
  ADD COLUMN IF NOT EXISTS moderated_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;

-- Fast "what needs my attention" queries in the admin panel.
CREATE INDEX IF NOT EXISTS user_photos_pending_idx
  ON user_photos (created_at) WHERE moderation = 'pending';
CREATE INDEX IF NOT EXISTS users_is_admin_idx
  ON users (id) WHERE is_admin;
