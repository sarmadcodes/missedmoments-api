/**
 * Contract test: every endpoint the mobile app calls, checked for the exact
 * fields the screens read.
 *
 * The smoke test proves the backend works. This proves the frontend and
 * backend agree on field names -- the failure mode that shows up as blank
 * text and "undefined" in the UI rather than as an error.
 *
 *   node test/contract.mjs
 */
const BASE = process.env.BASE ?? 'http://localhost:4100';

let passed = 0;
let failed = 0;

const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
};

/** Asserts every field a screen destructures is actually present. */
const hasFields = (label, obj, fields) => {
  if (!obj) {
    check(label, false, '(object missing entirely)');
    return;
  }
  const missing = fields.filter(f => !(f in obj));
  check(`${label} [${fields.join(', ')}]`, missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : '');
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

const resetRateLimits = async () => {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const keys = await redis.keys('fastify-rate-limit*');
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
};

const run = async () => {
  await resetRateLimits();
  const stamp = Date.now();
  const lat = 40 + Math.random() * 20;
  const lng = -60 + Math.random() * 100;

  const mk = (name, extra = {}) =>
    call('/v1/auth/register', {
      method: 'POST',
      body: {
        email: `${name}+${stamp}@contract.test`,
        password: 'contract-test-password',
        name,
        birthDate: '1995-06-06',
        ...extra,
      },
    });

  console.log('\n== AuthContext / LoginScreen / RegisterScreen ==');
  const a = await mk('Ada', { interests: ['music', 'travel'], city: 'London' });
  const b = await mk('Ben', { interests: ['music', 'travel'], city: 'London' });
  hasFields('register response', a.data, ['userId', 'accessToken', 'refreshToken']);

  const login = await call('/v1/auth/login', {
    method: 'POST',
    body: { email: `Ada+${stamp}@contract.test`, password: 'contract-test-password' },
  });
  hasFields('login response', login.data, ['userId', 'accessToken', 'refreshToken']);

  const A = a.data.accessToken;
  const B = b.data.accessToken;

  console.log('\n== ProfileScreen / SettingScreen / EditProfileScreen ==');
  const me = await call('/v1/users/me', { token: A });
  hasFields('GET /users/me', me.data, [
    'userId', 'name', 'email', 'age', 'city', 'bio',
    'isDiscoverable', 'isInvisible', 'notifyAll', 'notifyNewMatch', 'stats',
  ]);
  hasFields('  me.stats', me.data?.stats, ['likedYou', 'matches']);

  const patched = await call('/v1/users/me', {
    method: 'PATCH',
    token: A,
    body: { bio: 'Updated from the contract test', isInvisible: false },
  });
  check('PATCH /users/me accepts the app payload', patched.status === 200,
    JSON.stringify(patched.data));

  console.log('\n== DiscoverScreen / MatchesScreen ==');
  const checkIn = await call('/v1/moments/check-in', {
    method: 'POST', token: A,
    body: { latitude: lat, longitude: lng, accuracy: 10 },
  });
  hasFields('POST /moments/check-in', checkIn.data, ['moment', 'nearby']);
  hasFields('  checkIn.moment', checkIn.data?.moment, ['momentId', 'placeName', 'capturedAt']);

  await call('/v1/moments/check-in', {
    method: 'POST', token: B,
    body: { latitude: lat + 0.0002, longitude: lng, accuracy: 10 },
  });

  const nearby = await call('/v1/moments/nearby?window=hour', { token: A });
  check('GET /moments/nearby returns people[]', Array.isArray(nearby.data?.people));
  hasFields('  nearby person (MomentCard + SwipeCard)', nearby.data?.people?.[0], [
    'userId', 'name', 'age', 'photoUrl', 'placeName',
    'lastSeenAt', 'distanceMetres', 'matchPercentage',
  ]);

  console.log('\n== PersonProfileScreen ==');
  const other = await call(`/v1/users/${b.data.userId}`, { token: A });
  hasFields('GET /users/:id', other.data, [
    'userId', 'name', 'age', 'city', 'bio', 'photos', 'interests',
  ]);
  check('  photos is an array', Array.isArray(other.data?.photos));
  check('  interests is an array', Array.isArray(other.data?.interests));

  console.log('\n== LikesScreen ==');
  const liked = await call('/v1/likes', {
    method: 'POST', token: A,
    body: { targetUserId: b.data.userId, action: 'like' },
  });
  hasFields('POST /likes', liked.data, ['matched', 'matchId']);

  const admirers = await call('/v1/likes/admirers', { token: B });
  check('GET /likes/admirers returns people[]', Array.isArray(admirers.data?.people));
  hasFields('  admirer (PersonCard)', admirers.data?.people?.[0], [
    'userId', 'name', 'photoUrl', 'placeName',
  ]);

  const matchRes = await call('/v1/likes', {
    method: 'POST', token: B,
    body: { targetUserId: a.data.userId, action: 'like' },
  });
  check('mutual like returns a matchId', Boolean(matchRes.data?.matchId));
  const matchId = matchRes.data.matchId;

  console.log('\n== ChatsScreen ==');
  const matches = await call('/v1/likes/matches', { token: A });
  check('GET /likes/matches returns matches[]', Array.isArray(matches.data?.matches));
  hasFields('  match row (ChatCard)', matches.data?.matches?.[0], [
    'matchId', 'userId', 'name', 'photoUrl',
    'matchedAt', 'lastMessage', 'lastMessageAt', 'unreadCount',
  ]);

  console.log('\n== ChattingScreen ==');
  const sent = await call(`/v1/chat/${matchId}/messages`, {
    method: 'POST', token: A, body: { body: 'Contract test message' },
  });
  hasFields('POST /chat/:id/messages', sent.data, [
    'id', 'matchId', 'senderId', 'body', 'createdAt',
  ]);

  const thread = await call(`/v1/chat/${matchId}/messages`, { token: B });
  check('GET /chat/:id/messages returns messages[]', Array.isArray(thread.data?.messages));
  hasFields('  message (MessageBubble)', thread.data?.messages?.[0], [
    'id', 'senderId', 'body', 'createdAt', 'readAt',
  ]);

  const read = await call(`/v1/chat/${matchId}/read`, { method: 'POST', token: B });
  check('POST /chat/:id/read', read.status === 204, `got ${read.status}`);

  console.log('\n== NotificationScreen ==');
  const notes = await call('/v1/notifications', { token: B });
  check('GET /notifications returns notifications[]',
    Array.isArray(notes.data?.notifications));
  hasFields('  notification row', notes.data?.notifications?.[0], [
    'id', 'kind', 'body', 'createdAt', 'readAt', 'actorName', 'actorPhotoUrl',
  ]);

  console.log('\n== BlockUsersScreen / FeedbackScreen ==');
  await call('/v1/safety/blocks', {
    method: 'POST', token: A, body: { userId: b.data.userId },
  });
  const blocks = await call('/v1/safety/blocks', { token: A });
  check('GET /safety/blocks returns blocked[]', Array.isArray(blocks.data?.blocked));
  hasFields('  blocked row', blocks.data?.blocked?.[0], ['userId', 'name', 'photoUrl']);

  const unblock = await call(`/v1/safety/blocks/${b.data.userId}`, {
    method: 'DELETE', token: A,
  });
  check('DELETE /safety/blocks/:id', unblock.status === 204, `got ${unblock.status}`);

  const feedback = await call('/v1/safety/feedback', {
    method: 'POST', token: A, body: { reason: 'bugs', message: 'contract test' },
  });
  check('POST /safety/feedback', feedback.status === 201, `got ${feedback.status}`);

  console.log('\n== ChangePasswordScreen / DeleteAccount ==');
  const changed = await call('/v1/auth/change-password', {
    method: 'POST', token: A,
    body: { currentPassword: 'contract-test-password', newPassword: 'a-new-password-99' },
  });
  check('POST /auth/change-password', changed.status === 204, `got ${changed.status}`);

  const deactivate = await call('/v1/users/me/deactivate', { method: 'POST', token: B });
  check('POST /users/me/deactivate', deactivate.status === 204, `got ${deactivate.status}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
};

run().catch(err => {
  console.error('contract test crashed:', err);
  process.exit(1);
});
