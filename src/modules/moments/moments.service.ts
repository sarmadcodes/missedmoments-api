import { config } from '../../config.js';
import { query, queryOne, transaction } from '../../lib/db.js';
import { resolvePlace } from '../../lib/places.js';

export type CheckInInput = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  capturedAt?: string | null;
};

export type NearbyPerson = {
  userId: string;
  name: string;
  age: number | null;
  photoUrl: string | null;
  placeName: string | null;
  lastSeenAt: string;
  distanceMetres: number;
  sharedInterests: number;
  matchPercentage: number;
};

const WINDOWS: Record<string, string> = {
  hour: '1 hour',
  today: '1 day',
  week: '7 days',
};

/**
 * Records a check-in.
 *
 * The venue name is resolved through Google Places; the raw coordinate is
 * stored for the proximity query but is never returned to another user.
 */
export const checkIn = async (userId: string, input: CheckInInput) => {
  const capturedAt = input.capturedAt ? new Date(input.capturedAt) : new Date();
  const place = await resolvePlace(input.latitude, input.longitude);

  // Moments are deliberately short-lived; nothing older than the widest
  // browsing window is useful, and holding location history is a liability.
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const row = await queryOne<{ id: string; captured_at: Date }>(
    `INSERT INTO moments
       (user_id, location, accuracy_m, place_id, place_name, captured_at, expires_at)
     VALUES ($1, ST_MakePoint($3, $2)::geography, $4, $5, $6, $7, $8)
     RETURNING id, captured_at`,
    [
      userId,
      input.latitude,
      input.longitude,
      input.accuracy ?? null,
      place.placeId,
      place.placeName,
      capturedAt,
      expiresAt,
    ],
  );

  return {
    momentId: row!.id,
    placeName: place.placeName,
    capturedAt: row!.captured_at.toISOString(),
  };
};

/**
 * People whose check-ins overlapped yours in space and time.
 *
 * Excluded: yourself, anyone blocked in either direction, anyone you've
 * already acted on, users hidden by Invisible Mode or not discoverable, and
 * inactive accounts.
 *
 * `DISTINCT ON` collapses many overlapping moments per person down to their
 * single closest encounter.
 */
export const findNearby = async (
  userId: string,
  windowKey: keyof typeof WINDOWS | string = 'hour',
): Promise<NearbyPerson[]> => {
  const interval = WINDOWS[windowKey] ?? WINDOWS.hour;

  const rows = await query<{
    user_id: string;
    name: string;
    age: number | null;
    photo_url: string | null;
    place_name: string | null;
    last_seen_at: Date;
    distance_m: number;
    shared_interests: number;
  }>(
    `
    WITH my_moments AS (
      SELECT location, captured_at
        FROM moments
       WHERE user_id = $1
         AND captured_at > now() - $2::interval
    ),
    my_interests AS (
      SELECT interest_id FROM user_interests WHERE user_id = $1
    )
    SELECT DISTINCT ON (u.id)
           u.id                                   AS user_id,
           u.name,
           user_age(u.birth_date)                 AS age,
           p.url                                  AS photo_url,
           m.place_name,
           m.captured_at                          AS last_seen_at,
           ST_Distance(m.location, mine.location) AS distance_m,
           (SELECT count(*) FROM user_interests ui
             WHERE ui.user_id = u.id
               AND ui.interest_id IN (SELECT interest_id FROM my_interests))
                                                  AS shared_interests
      FROM moments m
      JOIN my_moments mine
        ON ST_DWithin(m.location, mine.location, $3)
       -- Same place is not enough; it has to be the same slice of time.
       AND m.captured_at BETWEEN mine.captured_at - $4::interval
                             AND mine.captured_at + $4::interval
      JOIN users u
        ON u.id = m.user_id
       AND u.status = 'active'
       AND u.is_discoverable
       AND NOT u.is_invisible
      LEFT JOIN user_photos p
        ON p.user_id = u.id
       AND p.is_primary
       AND p.moderation = 'approved'
     WHERE m.user_id <> $1
       AND m.captured_at > now() - $2::interval
       AND NOT EXISTS (
             SELECT 1 FROM blocks b
              WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1))
       AND NOT EXISTS (
             SELECT 1 FROM likes l
              WHERE l.liker_id = $1 AND l.liked_id = u.id)
     ORDER BY u.id, distance_m ASC, m.captured_at DESC
    `,
    [
      userId,
      interval,
      config.MOMENT_RADIUS_METRES,
      `${config.MOMENT_WINDOW_MINUTES} minutes`,
    ],
  );

  return rows
    .map(r => ({
      userId: r.user_id,
      name: r.name,
      age: r.age,
      photoUrl: r.photo_url,
      placeName: r.place_name,
      lastSeenAt: r.last_seen_at.toISOString(),
      distanceMetres: Math.round(r.distance_m),
      sharedInterests: r.shared_interests,
      matchPercentage: scoreMatch(r.distance_m, r.last_seen_at, r.shared_interests),
    }))
    .sort((a, b) => b.matchPercentage - a.matchPercentage);
};

/**
 * The "Moment match %" the app shows.
 *
 * Deliberately simple and explainable: closer, more recent and more shared
 * interests score higher. Tune the weights rather than reaching for ML at
 * this stage.
 */
const scoreMatch = (distanceM: number, seenAt: Date, sharedInterests: number) => {
  const radius = config.MOMENT_RADIUS_METRES;
  const proximity = Math.max(0, 1 - distanceM / radius); // 1 = same spot

  const ageMinutes = (Date.now() - seenAt.getTime()) / 60_000;
  const recency = Math.max(0, 1 - ageMinutes / config.MOMENT_WINDOW_MINUTES);

  const affinity = Math.min(1, sharedInterests / 3);

  const score = proximity * 0.4 + recency * 0.35 + affinity * 0.25;
  // Floor at 40 so the UI never shows a demoralising single-digit match.
  return Math.round(40 + score * 60);
};

/** Housekeeping: drop expired moments. Run from a scheduled job. */
export const purgeExpiredMoments = async () => {
  const rows = await query<{ count: number }>(
    'WITH d AS (DELETE FROM moments WHERE expires_at < now() RETURNING 1) SELECT count(*) FROM d',
  );
  return rows[0]?.count ?? 0;
};
