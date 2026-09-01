/**
 * End-to-end smoke test of the core product loop:
 *   register -> check in near each other -> discover -> mutual like -> match -> chat
 *
 * Run against a live server:  node test/smoke.mjs
 */
const BASE = process.env.BASE ?? 'http://localhost:4100';

let passed = 0;
let failed = 0;

const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
};

const call = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
};

/**
 * Clears this suite's own rate-limit budget so the test is repeatable.
 * The limits themselves stay production-strength; we only reset the counters,
 * and only against the local dev Redis.
 */
const resetRateLimits = async () => {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const keys = await redis.keys('fastify-rate-limit*');
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
  return keys.length;
};

const run = async () => {
  const cleared = await resetRateLimits();
  console.log(`(reset ${cleared} rate-limit counter(s) so this run starts clean)`);
  const stamp = Date.now();

  // A fresh location every run. Re-using fixed coordinates made earlier runs'
  // users show up in this run's results, which looked like product bugs but was
  // just the test colliding with its own leftovers.
  const baseLat = 40 + Math.random() * 20; // somewhere unremarkable
  const baseLng = -60 + Math.random() * 100;

  // ~25 m apart: well inside MOMENT_RADIUS_METRES (150 m).
  const alicePos = { latitude: baseLat, longitude: baseLng, accuracy: 12 };
  const bobPos = {
    latitude: baseLat + 0.000225,
    longitude: baseLng + 0.0000,
    accuracy: 15,
  };
  // ~4 km away: must NOT show up as a moment.
  const faraway = { latitude: baseLat + 0.036, longitude: baseLng, accuracy: 10 };

  console.log('\n== auth ==');
  const alice = await call('/v1/auth/register', {
    method: 'POST',
    body: {
      email: `alice+${stamp}@example.com`,
      password: 'correct-horse-battery',
      name: 'Alice',
      birthDate: '1996-04-12',
      interests: ['music', 'travel', 'food'],
    },
  });
  check('register alice', alice.status === 201, JSON.stringify(alice.data));

  const bob = await call('/v1/auth/register', {
    method: 'POST',
    body: {
      email: `bob+${stamp}@example.com`,
      password: 'correct-horse-battery',
      name: 'Bob',
      birthDate: '1994-02-02',
      interests: ['music', 'travel', 'gaming'],
    },
  });
  check('register bob', bob.status === 201);

  const carol = await call('/v1/auth/register', {
    method: 'POST',
    body: {
      email: `carol+${stamp}@example.com`,
      password: 'correct-horse-battery',
      name: 'Carol',
      birthDate: '1998-08-08',
    },
  });
  check('register carol', carol.status === 201);

  const dupe = await call('/v1/auth/register', {
    method: 'POST',
    body: { email: `alice+${stamp}@example.com`, password: 'another-password', name: 'Imposter' },
  });
  check('duplicate email rejected', dupe.status === 409, `got ${dupe.status}`);

  const underage = await call('/v1/auth/register', {
    method: 'POST',
    body: {
      email: `kid+${stamp}@example.com`,
      password: 'correct-horse-battery',
      name: 'Kid',
      birthDate: '2015-01-01',
    },
  });
  check('underage rejected', underage.status === 400, `got ${underage.status}`);

  const badLogin = await call('/v1/auth/login', {
    method: 'POST',
    body: { email: `alice+${stamp}@example.com`, password: 'wrong-password' },
  });
  check('wrong password rejected', badLogin.status === 401, `got ${badLogin.status}`);

  const goodLogin = await call('/v1/auth/login', {
    method: 'POST',
    body: { email: `alice+${stamp}@example.com`, password: 'correct-horse-battery' },
  });
  check('correct password accepted', goodLogin.status === 200);

  const noAuth = await call('/v1/users/me');
  check('protected route needs a token', noAuth.status === 401, `got ${noAuth.status}`);

  const A = alice.data.accessToken;
  const B = bob.data.accessToken;
  const C = carol.data.accessToken;

  console.log('\n== proximity engine ==');
  const aliceIn = await call('/v1/moments/check-in', { method: 'POST', body: alicePos, token: A });
  check('alice checks in', aliceIn.status === 200, JSON.stringify(aliceIn.data));

  const bobIn = await call('/v1/moments/check-in', { method: 'POST', body: bobPos, token: B });
  check('bob checks in nearby', bobIn.status === 200);

  const carolIn = await call('/v1/moments/check-in', { method: 'POST', body: faraway, token: C });
  check('carol checks in 4km away', carolIn.status === 200);

  const aliceId = alice.data.userId;
  const bobId = bob.data.userId;
  const carolId = carol.data.userId;

  const nearby = await call('/v1/moments/nearby?window=hour', { token: A });
  const found = (nearby.data?.people ?? []).map(p => p.userId);
  // Identity, not display name — names are not unique.
  check('alice sees bob nearby', found.includes(bobId), JSON.stringify(found));
  check('alice does NOT see faraway carol', !found.includes(carolId));
  check('alice does not see herself', !found.includes(aliceId));

  const bobRow = (nearby.data?.people ?? []).find(p => p.userId === bobId);
  check(
    'distance is plausible (<150m)',
    bobRow && bobRow.distanceMetres >= 0 && bobRow.distanceMetres < 150,
    `distance=${bobRow?.distanceMetres}`,
  );
  check(
    'shared interests counted (music+travel = 2)',
    bobRow?.sharedInterests === 2,
    `got ${bobRow?.sharedInterests}`,
  );
  check(
    'match % in range',
    bobRow && bobRow.matchPercentage >= 40 && bobRow.matchPercentage <= 100,
    `got ${bobRow?.matchPercentage}`,
  );
  check('raw coordinates are NOT leaked', bobRow && !('latitude' in bobRow));

  console.log('\n== likes and matching ==');
  const like1 = await call('/v1/likes', {
    method: 'POST',
    body: { targetUserId: bobId, action: 'like' },
    token: A,
  });
  check('alice likes bob', like1.status === 200);
  check('one-sided like does NOT match', like1.data?.matched === false);

  const admirers = await call('/v1/likes/admirers', { token: B });
  check(
    'bob sees a quiet admirer',
    (admirers.data?.people ?? []).some(p => p.userId === aliceId),
  );

  const afterLike = await call('/v1/moments/nearby?window=hour', { token: A });
  check(
    'already-liked person drops out of discover',
    !(afterLike.data?.people ?? []).some(p => p.userId === bobId),
  );

  const like2 = await call('/v1/likes', {
    method: 'POST',
    body: { targetUserId: aliceId, action: 'like' },
    token: B,
  });
  check('bob likes back', like2.status === 200);
  check('mutual like creates a match', like2.data?.matched === true);

  const matchId = like2.data?.matchId;
  const selfLike = await call('/v1/likes', {
    method: 'POST',
    body: { targetUserId: aliceId, action: 'like' },
    token: A,
  });
  check('cannot like yourself', selfLike.status === 400, `got ${selfLike.status}`);

  console.log('\n== chat ==');
  const msg = await call(`/v1/chat/${matchId}/messages`, {
    method: 'POST',
    body: { body: 'I knew it was you - Blue Door, right?' },
    token: A,
  });
  check('alice sends a message', msg.status === 201, JSON.stringify(msg.data));

  const thread = await call(`/v1/chat/${matchId}/messages`, { token: B });
  check('bob reads the thread', (thread.data?.messages ?? []).length === 1);

  const intruder = await call(`/v1/chat/${matchId}/messages`, { token: C });
  check('outsider cannot read the chat', intruder.status === 404 || intruder.status === 403,
    `got ${intruder.status}`);

  const matches = await call('/v1/likes/matches', { token: A });
  const m = (matches.data?.matches ?? [])[0];
  check('match appears in inbox', m?.userId === bobId);
  check('last message shown in inbox', Boolean(m?.lastMessage));

  const unread = await call('/v1/likes/matches', { token: B });
  check('unread count for bob is 1', unread.data?.matches?.[0]?.unreadCount === 1,
    `got ${unread.data?.matches?.[0]?.unreadCount}`);

  await call(`/v1/chat/${matchId}/read`, { method: 'POST', token: B });
  const readNow = await call('/v1/likes/matches', { token: B });
  check('unread clears after read', readNow.data?.matches?.[0]?.unreadCount === 0);

  console.log('\n== anonymity ==');
  const bobNotes = await call('/v1/notifications', { token: B });
  const likeNotes = (bobNotes.data?.notifications ?? []).filter(
    n => n.kind === 'like',
  );
  check('bob got a like notification', likeNotes.length > 0);
  check(
    'a one-sided like never reveals who sent it',
    likeNotes.every(n => !n.actorName && !n.actorPhotoUrl),
    JSON.stringify(likeNotes.map(n => n.actorName)),
  );
  const matchNotes = (bobNotes.data?.notifications ?? []).filter(
    n => n.kind === 'match',
  );
  check(
    'a match DOES reveal the other person',
    matchNotes.length > 0 && matchNotes.every(n => n.actorName),
  );

  console.log('\n== safety ==');
  await call('/v1/safety/blocks', { method: 'POST', body: { userId: bobId }, token: A });
  const blockedProfile = await call(`/v1/users/${bobId}`, { token: A });
  check('blocked user looks like it does not exist', blockedProfile.status === 404,
    `got ${blockedProfile.status}`);

  const afterBlock = await call('/v1/likes/matches', { token: A });
  check('block closes the conversation', (afterBlock.data?.matches ?? []).length === 0);

  console.log('\n== tokens ==');
  const refreshed = await call('/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: alice.data.refreshToken },
  });
  check('refresh returns a new access token', Boolean(refreshed.data?.accessToken));
  check('refresh token rotates',
    refreshed.data?.refreshToken !== alice.data.refreshToken);

  const reused = await call('/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: alice.data.refreshToken },
  });
  check('old refresh token cannot be reused', reused.status === 401, `got ${reused.status}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
};

run().catch(err => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
