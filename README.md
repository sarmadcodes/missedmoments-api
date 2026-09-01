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
| `POST` | `/v1/media/upload-ticket` | Signed Cloudinary upload ticket |
| `POST` | `/v1/media/photos` | Register an uploaded photo |
| `GET` | `/v1/media/photos` | Your photos |
| `PATCH` | `/v1/media/photos/:id/primary` | Set the avatar |
| `DELETE` | `/v1/media/photos/:id` | Remove a photo (queues CDN delete) |
| `GET` | `/v1/media/status` | Whether uploads are configured |

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

`npm run smoke` — 40/40 passing, covering registration, duplicate/underage
rejection, wrong-password rejection, proximity matching (including that someone
4 km away is correctly excluded), interest scoring, one-sided likes staying
silent, mutual likes creating a match, chat access control, unread counts,
blocking, one-sided likes staying anonymous in the notification feed, and
refresh-token rotation and reuse-rejection.

`npm run contract` — 30/30, checking every endpoint the app calls returns the
exact fields the corresponding screen reads.

`npm test` — Cloudinary signature unit tests, pinned against the worked
example in Cloudinary'"'"'s own documentation.

## Images (Cloudinary)

Uploads are **signed and direct**: the app asks for a signature, uploads
straight to Cloudinary, then reports the `public_id` back. Image bytes never
pass through this server, so a slow mobile upload does not tie up an API
connection, and the API secret never leaves this process.

The reported `public_id` is verified against Cloudinary before it is trusted,
and must sit under `missedmoments/users/<that user id>/` — otherwise a caller
could claim any asset in the account, including someone else's photo.

Set these in `.env` from your Cloudinary dashboard:

```
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

`GET /v1/media/status` reports whether they are present, so the app can say
uploads are unavailable rather than failing oddly.

Deletes are queued in `pending_media_deletions` and attempted immediately: a
Cloudinary outage must not stop someone removing their own photo, and deleting
an account must not leave its images live on the CDN.

**Moderation is not implemented.** `PHOTO_AUTO_APPROVE=true` publishes uploads
immediately. The `moderation` column and the `approved` gate already exist, so
wiring a provider is a change in one place — but until then this is an
unmoderated image host, which is the main risk before real users.

## Not built yet

- **Social sign-in** (Google/Apple/Facebook) — the `user_identities` table and
  the app's buttons exist; the token-exchange endpoints do not.
- **Photo moderation** — see the Images section above.
- **Push delivery** — device tokens are stored; nothing sends to FCM/APNs.
- **Scheduled purge** of expired moments — `purgeExpiredMoments()` exists but
  nothing calls it on a timer.
