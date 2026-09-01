# MissedMoments API

Backend for MissedMoments — Node + TypeScript + Fastify, PostgreSQL/PostGIS, Redis.

## What it does

The product premise is *proximity + time + mutual consent*: you and someone else
were in the same place at roughly the same time, and neither of you knows unless
you both tap a heart.

That is enforced in one SQL query (`src/modules/moments/moments.service.ts`),
which joins your check-ins against everyone else's on **both** a spatial
predicate (`ST_DWithin`) and a temporal one, then filters out blocks, people you
have already swiped, invisible/undiscoverable users and inactive accounts.

## Running it

```bash
cp .env.example .env       # then set GOOGLE_MAPS_API_KEY
docker compose up -d       # Postgres + PostGIS, Redis
npm install
npm run migrate
npm run dev
```

Health check: `curl http://localhost:4100/health`

Full end-to-end test against a running server:

```bash
npm run smoke
```

> **Port note:** this defaults to **4100**, not 4000, because port 4000 is
> already used by the `sms-relay` project on this machine.

> **PostGIS image note:** compose uses `postgis/postgis:16-3.4-alpine`. The
> Debian-based `16-3.4` tag fails with `exec format error` on this Docker
> Desktop install even though the architecture matches.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/auth/register` | Create account (18+ enforced) |
| `POST` | `/v1/auth/login` | Email + password |
| `POST` | `/v1/auth/refresh` | Rotate tokens |
| `POST` | `/v1/auth/logout` | Revoke all sessions |
| `POST` | `/v1/auth/change-password` | Revokes other sessions |
| `GET/PATCH` | `/v1/users/me` | Profile + settings toggles |
| `GET` | `/v1/users/:id` | Public profile (404s if blocked) |
| `POST` | `/v1/users/me/deactivate` | "Take a break" — reversible |
| `DELETE` | `/v1/users/me` | Soft delete + immediate data strip |
| `POST` | `/v1/moments/check-in` | Record a moment, get who's nearby |
| `GET` | `/v1/moments/nearby?window=hour\|today\|week` | Discover feed |
| `POST` | `/v1/likes` | like / pass, returns `{matched, matchId}` |
| `GET` | `/v1/likes/admirers` | "Quiet Admirers" |
| `GET` | `/v1/likes/matches` | Inbox with unread counts |
| `GET/POST` | `/v1/chat/:matchId/messages` | History / send |
| `POST` | `/v1/chat/:matchId/read` | Mark read |
| `WS` | `/v1/chat/ws?token=…` | Realtime messages |
| `GET/POST` | `/v1/notifications` | Feed + mark read |
| `POST` | `/v1/notifications/devices` | Register push token |
| `GET/POST/DELETE` | `/v1/safety/blocks` | Block list |
| `POST` | `/v1/safety/reports` | Report a user |
| `POST` | `/v1/safety/feedback` | Feedback form |

## Security decisions

- **Passwords**: Argon2id at OWASP-minimum parameters. Login always runs a
  verify even for unknown emails so timing does not reveal who is registered.
- **Refresh tokens**: random, stored only as SHA-256, and **rotated on every
  use** — a stolen token works at most once, and reuse is rejected.
- **Location privacy**: raw coordinates are never returned to another user.
  Peers see a venue name, a rounded distance and a timestamp. Moments expire
  and are purged; deleting your account drops location history immediately.
- **Blocking** is symmetric and indistinguishable from non-existence (404).
- **Google API key** is server-side only and never shipped in the app.
- **Rate limits**: 300/min globally, 10 per 15 min on auth, 30/hr on check-in
  (which is what costs money at Google).
- Errors are normalised so internals never leak to clients.

## Verified

`npm run smoke` — 37/37 passing, covering registration, duplicate/underage
rejection, wrong-password rejection, proximity matching (including that someone
4 km away is correctly excluded), interest scoring, one-sided likes staying
silent, mutual likes creating a match, chat access control, unread counts,
blocking, and refresh-token rotation and reuse-rejection.

## Not built yet

- **Social sign-in** (Google/Apple/Facebook) — the `user_identities` table and
  the app's buttons exist; the token-exchange endpoints do not.
- **Photo upload / moderation** — `user_photos.moderation` gates on
  `approved`, but there is no upload endpoint or S3/R2 wiring yet. This is the
  main gap before real users.
- **Push delivery** — device tokens are stored; nothing sends to FCM/APNs.
- **Scheduled purge** of expired moments — `purgeExpiredMoments()` exists but
  nothing calls it on a timer.
