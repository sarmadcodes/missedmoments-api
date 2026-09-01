import { query, queryOne } from '../../lib/db.js';
import { forbidden, notFound } from '../../lib/errors.js';

/** Confirms the user is a participant in the match; every chat call goes through this. */
export const assertParticipant = async (matchId: string, userId: string) => {
  const match = await queryOne<{ user_a: string; user_b: string }>(
    `SELECT user_a, user_b FROM matches
      WHERE id = $1 AND closed_at IS NULL`,
    [matchId],
  );

  if (!match) throw notFound('Conversation not found');
  if (match.user_a !== userId && match.user_b !== userId) {
    throw forbidden('Not your conversation');
  }

  return match.user_a === userId ? match.user_b : match.user_a;
};

export const listMessages = async (
  matchId: string,
  userId: string,
  before?: string,
  limit = 50,
) => {
  await assertParticipant(matchId, userId);

  const rows = await query(
    `SELECT id, sender_id AS "senderId", body, created_at AS "createdAt",
            read_at AS "readAt"
       FROM messages
      WHERE match_id = $1
        AND ($2::timestamptz IS NULL OR created_at < $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [matchId, before ?? null, Math.min(limit, 100)],
  );

  // Oldest-first is what a chat view wants to render.
  return rows.reverse();
};

export const sendMessage = async (matchId: string, senderId: string, body: string) => {
  const recipientId = await assertParticipant(matchId, senderId);

  const message = await queryOne<{ id: string; created_at: Date }>(
    `INSERT INTO messages (match_id, sender_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [matchId, senderId, body],
  );

  await query(
    `INSERT INTO notifications (user_id, kind, actor_id, body)
     VALUES ($1, 'message', $2, 'New message')`,
    [recipientId, senderId],
  );

  return {
    id: message!.id,
    matchId,
    senderId,
    body,
    createdAt: message!.created_at.toISOString(),
    recipientId,
  };
};

export const markRead = async (matchId: string, userId: string) => {
  await assertParticipant(matchId, userId);
  await query(
    `UPDATE messages SET read_at = now()
      WHERE match_id = $1 AND sender_id <> $2 AND read_at IS NULL`,
    [matchId, userId],
  );
};
