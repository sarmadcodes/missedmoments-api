-- MissedMoments initial schema.
--
-- Design notes:
--  * All ids are UUIDs so they can be exposed in URLs without leaking counts.
--  * Location lives in `geography(Point,4326)`, not two float columns, so
--    PostGIS can answer "within N metres" with a real spheroid distance and
--    use a GiST index for it.
--  * A "moment" is one foreground check-in. Two people match on a moment when
--    their check-ins are close in BOTH space and time.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               CITEXT UNIQUE NOT NULL,
  password_hash       TEXT,                       -- NULL for social-only accounts
  phone               TEXT,
  name                TEXT NOT NULL,
  birth_date          DATE,
  gender              TEXT,
  city                TEXT,
  bio                 TEXT,

  -- Settings screen toggles.
  is_discoverable     BOOLEAN NOT NULL DEFAULT TRUE,
  is_invisible        BOOLEAN NOT NULL DEFAULT FALSE,
  notify_all          BOOLEAN NOT NULL DEFAULT TRUE,
  notify_new_match    BOOLEAN NOT NULL DEFAULT TRUE,

  -- Lifecycle. `deactivated` is the "take a break" state; `deleted_at` is a
  -- soft delete so a hard purge can run out-of-band.
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'deactivated', 'deleted')),
  deleted_at          TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX users_status_idx ON users (status) WHERE status = 'active';

-- Age is derived from birth_date, never stored, so it cannot drift.
CREATE OR REPLACE FUNCTION user_age(birth DATE) RETURNS INT
  LANGUAGE sql IMMUTABLE AS
$$ SELECT EXTRACT(YEAR FROM age(current_date, birth))::INT $$;

-- ------------------------------------------------------------- identities
-- Google / Apple / Facebook sign-in.
CREATE TABLE user_identities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('google', 'apple', 'facebook')),
  provider_uid  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_uid)
);

-- ---------------------------------------------------------------- photos
CREATE TABLE user_photos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  position      SMALLINT NOT NULL DEFAULT 0,
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Every uploaded photo is held until moderation clears it.
  moderation    TEXT NOT NULL DEFAULT 'pending'
                  CHECK (moderation IN ('pending', 'approved', 'rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX user_photos_user_idx ON user_photos (user_id, position);
-- At most one primary photo per user.
CREATE UNIQUE INDEX user_photos_one_primary
  ON user_photos (user_id) WHERE is_primary;

-- ------------------------------------------------------------- interests
CREATE TABLE interests (
  id    TEXT PRIMARY KEY,        -- 'music', 'travel', ... matches the app
  name  TEXT NOT NULL
);

CREATE TABLE user_interests (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interest_id  TEXT NOT NULL REFERENCES interests(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, interest_id)
);

INSERT INTO interests (id, name) VALUES
  ('music','Music'), ('dance','Dance'), ('party','Party'), ('movies','Movies'),
  ('sports','Sports'), ('travel','Travel'), ('food','Food'),
  ('photography','Photography'), ('gaming','Gaming')
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------------- moments
-- One row per foreground check-in.
CREATE TABLE moments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location      GEOGRAPHY(POINT, 4326) NOT NULL,
  accuracy_m    REAL,

  -- Venue resolved server-side via Google Places; cached so the same spot is
  -- not re-billed on every check-in.
  place_id      TEXT,
  place_name    TEXT,

  captured_at   TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Moments are transient by design; a cron deletes anything past this.
  expires_at    TIMESTAMPTZ NOT NULL
);

-- The index that makes the whole product work: spatial + temporal together.
CREATE INDEX moments_location_idx ON moments USING GIST (location);
CREATE INDEX moments_captured_idx ON moments (captured_at DESC);
CREATE INDEX moments_user_captured_idx ON moments (user_id, captured_at DESC);

-- Cache of resolved venues so repeat check-ins at one place cost no API call.
CREATE TABLE places (
  place_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  location      GEOGRAPHY(POINT, 4326) NOT NULL,
  address       TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX places_location_idx ON places USING GIST (location);

-- ----------------------------------------------------------------- likes
CREATE TABLE likes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  liker_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  liked_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Which shared moment prompted it (nullable: likes from the swipe deck).
  moment_id     UUID REFERENCES moments(id) ON DELETE SET NULL,
  action        TEXT NOT NULL CHECK (action IN ('like', 'pass')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (liker_id, liked_id),
  CHECK (liker_id <> liked_id)
);

CREATE INDEX likes_liked_idx ON likes (liked_id) WHERE action = 'like';
CREATE INDEX likes_liker_idx ON likes (liker_id);

-- --------------------------------------------------------------- matches
-- Created only when both sides liked. user_a < user_b keeps one row per pair.
CREATE TABLE matches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  UNIQUE (user_a, user_b),
  CHECK (user_a < user_b)
);

CREATE INDEX matches_user_a_idx ON matches (user_a) WHERE closed_at IS NULL;
CREATE INDEX matches_user_b_idx ON matches (user_b) WHERE closed_at IS NULL;

-- -------------------------------------------------------------- messages
CREATE TABLE messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id      UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sender_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at       TIMESTAMPTZ
);

-- Paging a conversation newest-first.
CREATE INDEX messages_match_created_idx ON messages (match_id, created_at DESC);
-- Unread badge counts.
CREATE INDEX messages_unread_idx ON messages (match_id, sender_id)
  WHERE read_at IS NULL;

-- --------------------------------------------------------------- safety
CREATE TABLE blocks (
  blocker_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE TABLE reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  detail        TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'reviewing', 'actioned', 'dismissed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reports_status_idx ON reports (status, created_at DESC);

-- ---------------------------------------------------------------- tokens
-- Refresh tokens are stored hashed so a database leak cannot mint sessions.
CREATE TABLE refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id)
  WHERE revoked_at IS NULL;

-- --------------------------------------------------------- notifications
CREATE TABLE notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('like', 'match', 'message', 'system')),
  actor_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- Device tokens for push (FCM / APNs).
CREATE TABLE device_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  platform      TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- feedback
CREATE TABLE feedback (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  reason        TEXT NOT NULL,
  message       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------- updated_at trigger
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER
  LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
