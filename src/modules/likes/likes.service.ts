import { query, queryOne, transaction } from '../../lib/db.js';
import { badRequest, forbidden } from '../../lib/errors.js';

export type LikeResult = {
  matched: boolean;
  matchId: string | null;
};

/**
 * Records a like or pass.
 *
 * The whole flow runs in one transaction and takes the two user rows in a
 * deterministic order, so two people liking each other at the same instant
 * cannot deadlock or produce two match rows.
 */
export const likeUser = async (
  actorId: string,
  targetId: string,
  action: 'like' | 'pass',
  momentId?: string | null,
): Promise<LikeResult> => {
  if (actorId === targetId) {
    throw badRequest('SELF_LIKE', 'You cannot like yourself');
  }

  return transaction(async client => {
    const blocked = await queryOne(
      `SELECT 1 FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = $2)
           OR (blocker_id = $2 AND blocked_id = $1)`,
      [actorId, targetId],
      client,
    );
    if (blocked) throw forbidden('This person is unavailable');

    const target = await queryOne<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 AND status = 'active'",
      [targetId],
      client,
    );
    if (!target) throw badRequest('NO_SUCH_USER', 'That person is no longer available');

    await query(
      `INSERT INTO likes (liker_id, liked_id, moment_id, action)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (liker_id, liked_id)
       DO UPDATE SET action = EXCLUDED.action, created_at = now()`,
      [actorId, targetId, momentId ?? null, action],
      client,
    );

    if (action === 'pass') {
      return { matched: false, matchId: null };
    }

    const reciprocal = await queryOne(
      `SELECT 1 FROM likes
        WHERE liker_id = $1 AND liked_id = $2 AND action = 'like'`,
      [targetId, actorId],
      client,
    );

    if (!reciprocal) {
      // A one-sided like stays silent by design — that is the product.
      await query(
        `INSERT INTO notifications (user_id, kind, actor_id, body)
         VALUES ($1, 'like', $2, 'Someone liked your moment')`,
        [targetId, actorId],
        client,
      );
      return { matched: false, matchId: null };
    }

    // Canonical ordering satisfies the user_a < user_b constraint and gives
    // both concurrent transactions the same lock order.
    const [a, b] = actorId < targetId ? [actorId, targetId] : [targetId, actorId];

    const match = await queryOne<{ id: string }>(
      `INSERT INTO matches (user_a, user_b)
       VALUES ($1, $2)
       ON CONFLICT (user_a, user_b) DO UPDATE SET closed_at = NULL
       RETURNING id`,
      [a, b],
      client,
    );

    await query(
      `INSERT INTO notifications (user_id, kind, actor_id, body)
       VALUES ($1, 'match', $2, 'You have a new match'),
              ($2, 'match', $1, 'You have a new match')`,
      [actorId, targetId],
      client,
    );

    return { matched: true, matchId: match!.id };
  });
};

/** "Quiet Admirers" — people who liked you and are still waiting. */
export const listAdmirers = async (userId: string) =>
  query(
    `SELECT u.id            AS "userId",
            u.name,
            user_age(u.birth_date) AS age,
            p.url           AS "photoUrl",
            l.created_at    AS "likedAt",
            m.place_name    AS "placeName"
       FROM likes l
       JOIN users u ON u.id = l.liker_id AND u.status = 'active'
       LEFT JOIN user_photos p
              ON p.user_id = u.id AND p.is_primary AND p.moderation = 'approved'
       LEFT JOIN moments m ON m.id = l.moment_id
      WHERE l.liked_id = $1
        AND l.action = 'like'
        -- Hide anyone you've already responded to.
        AND NOT EXISTS (SELECT 1 FROM likes mine
                         WHERE mine.liker_id = $1 AND mine.liked_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                            OR (b.blocker_id = u.id AND b.blocked_id = $1))
      ORDER BY l.created_at DESC
      LIMIT 50`,
    [userId],
  );

export const listMatches = async (userId: string) =>
  query(
    `SELECT m.id                AS "matchId",
            u.id                AS "userId",
            u.name,
            p.url               AS "photoUrl",
            m.created_at        AS "matchedAt",
            last.body           AS "lastMessage",
            last.created_at     AS "lastMessageAt",
            COALESCE(unread.count, 0) AS "unreadCount"
       FROM matches m
       JOIN users u
         ON u.id = CASE WHEN m.user_a = $1 THEN m.user_b ELSE m.user_a END
        AND u.status = 'active'
       LEFT JOIN user_photos p
              ON p.user_id = u.id AND p.is_primary AND p.moderation = 'approved'
       LEFT JOIN LATERAL (
              SELECT body, created_at FROM messages
               WHERE match_id = m.id
               ORDER BY created_at DESC LIMIT 1) last ON TRUE
       LEFT JOIN LATERAL (
              SELECT count(*)::int AS count FROM messages
               WHERE match_id = m.id
                 AND sender_id <> $1
                 AND read_at IS NULL) unread ON TRUE
      WHERE (m.user_a = $1 OR m.user_b = $1)
        AND m.closed_at IS NULL
      ORDER BY COALESCE(last.created_at, m.created_at) DESC`,
    [userId],
  );
