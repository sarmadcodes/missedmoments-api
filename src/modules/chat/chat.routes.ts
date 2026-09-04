import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as service from './chat.service.js';
import { verifyAccessToken } from '../../lib/tokens.js';
import { redis } from '../../lib/redis.js';
import { sendPushToUser } from '../../lib/push.js';

type ChatMessage = Awaited<ReturnType<typeof service.sendMessage>>;

const paramsSchema = z.object({ matchId: z.string().uuid() });

/**
 * Realtime chat.
 *
 * Sockets are held per user in this process and fanned out via Redis pub/sub,
 * so the design already works when there is more than one API instance behind
 * a load balancer.
 */
const sockets = new Map<string, Set<import('ws').WebSocket>>();

const addSocket = (userId: string, ws: import('ws').WebSocket) => {
  const set = sockets.get(userId) ?? new Set();
  set.add(ws);
  sockets.set(userId, set);
};

const removeSocket = (userId: string, ws: import('ws').WebSocket) => {
  const set = sockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (!set.size) sockets.delete(userId);
};

const deliver = (userId: string, payload: unknown) => {
  const set = sockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(data);
  }
};

/**
 * Fans a new message out over the live WebSocket (if the recipient has one
 * open) and sends a push. Both the REST send and the WS send paths call this
 * one function rather than duplicating the logic, since a message can arrive
 * from either.
 *
 * No message body ever leaves in the push payload -- only that a message
 * exists -- so a lock-screen notification preview cannot expose a private
 * conversation to anyone else with physical access to the phone.
 */
const broadcastNewMessage = async (message: ChatMessage) => {
  await redis.publish(
    'chat',
    JSON.stringify({ to: message.recipientId, payload: { type: 'message', message } }),
  );
  void sendPushToUser(message.recipientId, {
    title: 'New message',
    body: 'You have a new message',
    data: { type: 'message', matchId: message.matchId },
  });
};

export default async function chatRoutes(fastify: FastifyInstance) {
  // One subscriber per process rebroadcasts to whichever sockets are local.
  const subscriber = redis.duplicate();
  await subscriber.subscribe('chat');
  subscriber.on('message', (_channel, raw) => {
    try {
      const event = JSON.parse(raw) as { to: string; payload: unknown };
      deliver(event.to, event.payload);
    } catch {
      /* ignore malformed */
    }
  });

  fastify.addHook('onClose', async () => {
    await subscriber.quit();
  });

  // ---------------------------------------------------------------- REST
  fastify.get(
    '/:matchId/messages',
    { onRequest: [fastify.authenticate] },
    async req => {
      const { matchId } = paramsSchema.parse(req.params);
      const { before, limit } = z
        .object({
          before: z.string().datetime().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(req.query);

      return { messages: await service.listMessages(matchId, req.userId!, before, limit) };
    },
  );

  fastify.post(
    '/:matchId/messages',
    { onRequest: [fastify.authenticate] },
    async (req, reply) => {
      const { matchId } = paramsSchema.parse(req.params);
      const { body } = z.object({ body: z.string().min(1).max(2000) }).parse(req.body);

      const message = await service.sendMessage(matchId, req.userId!, body);
      await broadcastNewMessage(message);

      return reply.status(201).send(message);
    },
  );

  fastify.post(
    '/:matchId/read',
    { onRequest: [fastify.authenticate] },
    async (req, reply) => {
      const { matchId } = paramsSchema.parse(req.params);
      await service.markRead(matchId, req.userId!);
      return reply.status(204).send();
    },
  );

  // ----------------------------------------------------------- WebSocket
  // Browsers cannot set headers on a WS handshake, so the token comes as a
  // query param. It is short-lived and the connection is TLS in production.
  fastify.get('/ws', { websocket: true }, async (socket, req) => {
    const parsed = z
      .object({ token: z.string().min(1) })
      .safeParse(req.query);

    if (!parsed.success) {
      socket.close(1008, 'token required');
      return;
    }

    let userId: string;
    try {
      ({ sub: userId } = await verifyAccessToken(parsed.data.token));
    } catch {
      socket.close(1008, 'invalid token');
      return;
    }

    addSocket(userId, socket);
    socket.send(JSON.stringify({ type: 'ready' }));

    socket.on('message', async (raw: unknown) => {
      try {
        const event = JSON.parse(String(raw));

        if (event.type === 'send') {
          const { matchId, body } = z
            .object({ matchId: z.string().uuid(), body: z.string().min(1).max(2000) })
            .parse(event);

          const message = await service.sendMessage(matchId, userId, body);
          socket.send(JSON.stringify({ type: 'sent', message }));
          await broadcastNewMessage(message);
        }

        if (event.type === 'read') {
          const { matchId } = paramsSchema.parse(event);
          await service.markRead(matchId, userId);
        }
      } catch (err) {
        socket.send(
          JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Bad message',
          }),
        );
      }
    });

    socket.on('close', () => removeSocket(userId, socket));
  });
}
