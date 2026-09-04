/**
 * Admin panel: auth boundary, moderation, and suspend/ban enforcement.
 *
 * Requires an admin account to already exist. Run:
 *   node scripts/make-admin.mjs --email <you> --key <ADMIN_BOOTSTRAP_KEY>
 * then:
 *   ADMIN_EMAIL=<you> ADMIN_PASSWORD=<pw> node test/admin.mjs
 */
const BASE = process.env.BASE ?? 'http://localhost:4100';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'demo@missedmoments.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'demo-password-123';

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
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text; // e.g. the admin page's HTML
    }
  }
  return { status: res.status, data };
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

  console.log('\n== admin auth boundary ==');
  const normal = await call('/v1/auth/register', {
    method: 'POST',
    body: {
      email: `admintest+${stamp}@example.com`,
      password: 'testpassword123',
      name: 'Admin Test Subject',
      birthDate: '1995-01-01',
    },
  });
  const normalToken = normal.data.accessToken;
  const normalId = normal.data.userId;

  const denied = await call('/v1/admin/stats', { token: normalToken });
  check('a normal user gets 403 from an admin route', denied.status === 403,
    `got ${denied.status}`);

  const noAuth = await call('/v1/admin/stats');
  check('no token gets 401', noAuth.status === 401, `got ${noAuth.status}`);

  const badLogin = await call('/v1/admin/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: 'definitely-wrong' },
  });
  check('wrong password on admin login is rejected', badLogin.status === 401);

  const adminLogin = await call('/v1/admin/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  check('admin login succeeds for a real admin account', adminLogin.status === 200,
    JSON.stringify(adminLogin.data));
  const adminToken = adminLogin.data?.accessToken;
  if (!adminToken) {
    console.log(
      `\nNo admin token -- make sure ${ADMIN_EMAIL} has is_admin=true ` +
        '(scripts/make-admin.mjs). Stopping.\n',
    );
    process.exit(1);
  }

  console.log('\n== dashboard ==');
  const stats = await call('/v1/admin/stats', { token: adminToken });
  check('stats endpoint returns counts', stats.status === 200);
  check('stats has the expected shape', [
    'totalUsers', 'activeUsers', 'openReports', 'activeMatches', 'pendingPhotos',
  ].every(k => typeof stats.data?.[k] === 'number'), JSON.stringify(stats.data));

  console.log('\n== user search and suspend/ban lifecycle ==');
  const search = await call(
    `/v1/admin/users?q=${encodeURIComponent(`admintest+${stamp}`)}`,
    { token: adminToken },
  );
  check('search finds the test user', search.data?.users?.some(u => u.userId === normalId));

  const loginBefore = await call('/v1/auth/login', {
    method: 'POST',
    body: { email: `admintest+${stamp}@example.com`, password: 'testpassword123' },
  });
  check('target can log in before any action', loginBefore.status === 200);

  const suspend = await call(`/v1/admin/users/${normalId}/suspend`, {
    method: 'POST', token: adminToken,
  });
  check('suspend succeeds', suspend.status === 204, `got ${suspend.status}`);

  const loginSuspended = await call('/v1/auth/login', {
    method: 'POST',
    body: { email: `admintest+${stamp}@example.com`, password: 'testpassword123' },
  });
  check('suspended user cannot log in', loginSuspended.status === 401);
  check('suspension message is specific, not generic', loginSuspended.data?.message
    ?.toLowerCase().includes('suspend'), loginSuspended.data?.message);

  const refreshSuspended = await call('/v1/auth/refresh', {
    method: 'POST', body: { refreshToken: normal.data.refreshToken },
  });
  check('an existing refresh token is rejected immediately after suspend',
    refreshSuspended.status === 401, `got ${refreshSuspended.status}`);

  const restore = await call(`/v1/admin/users/${normalId}/restore`, {
    method: 'POST', token: adminToken,
  });
  check('restore succeeds', restore.status === 204);

  const loginRestored = await call('/v1/auth/login', {
    method: 'POST',
    body: { email: `admintest+${stamp}@example.com`, password: 'testpassword123' },
  });
  check('restored user can log in again', loginRestored.status === 200);

  const meAdmin = await call('/v1/users/me', { token: adminToken });
  const selfSuspend = await call(`/v1/admin/users/${meAdmin.data.userId}/suspend`, {
    method: 'POST', token: adminToken,
  });
  check('an admin cannot be suspended via this endpoint',
    selfSuspend.status === 400, `got ${selfSuspend.status}`);

  console.log('\n== photo moderation gate ==');
  const photoUser = await call('/v1/auth/register', {
    method: 'POST',
    body: {
      email: `modtest+${stamp}@example.com`,
      password: 'testpassword123',
      name: 'Moderation Test',
      birthDate: '1995-01-01',
    },
  });
  const photoToken = photoUser.data.accessToken;
  const photoUserId = photoUser.data.userId;

  const status = await call('/v1/media/status', { token: photoToken });
  if (!status.data?.uploadsEnabled) {
    console.log('  SKIP  (Cloudinary not configured on this server)');
  } else {
    const ticket = await call('/v1/media/upload-ticket', { method: 'POST', token: photoToken });
    const form = new FormData();
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    form.append('file', new Blob([pngBytes]), 'test.png');
    form.append('api_key', ticket.data.apiKey);
    form.append('timestamp', String(ticket.data.timestamp));
    form.append('signature', ticket.data.signature);
    form.append('folder', ticket.data.folder);
    form.append('transformation', 'c_limit,w_1440,h_1440,q_auto:good');

    const uploaded = await fetch(ticket.data.uploadUrl, { method: 'POST', body: form })
      .then(r => r.json());

    const registered = await call('/v1/media/photos', {
      method: 'POST', token: photoToken, body: { publicId: uploaded.public_id },
    });

    check('a fresh upload is NOT auto-approved',
      registered.data?.moderation === 'pending', registered.data?.moderation);

    const profileBefore = await call(`/v1/users/${photoUserId}`, { token: photoToken });
    check('a pending photo is invisible on the public profile',
      (profileBefore.data?.photos ?? []).length === 0,
      JSON.stringify(profileBefore.data?.photos));

    const pending = await call('/v1/admin/photos/pending', { token: adminToken });
    check('the photo appears in the admin queue',
      pending.data?.photos?.some(p => p.id === registered.data.id));

    const approve = await call(`/v1/admin/photos/${registered.data.id}/approve`, {
      method: 'POST', token: adminToken,
    });
    check('approve succeeds', approve.status === 204);

    const profileAfter = await call(`/v1/users/${photoUserId}`, { token: photoToken });
    check('the photo is visible after approval',
      (profileAfter.data?.photos ?? []).length === 1);
  }

  console.log('\n== reports queue ==');
  const reportRes = await call('/v1/safety/reports', {
    method: 'POST', token: normalToken,
    body: { userId: photoUserId, reason: 'inappropriate', detail: 'test report' },
  });
  check('a normal user can file a report', reportRes.status === 201);

  const reports = await call('/v1/admin/reports?status=open', { token: adminToken });
  const filed = reports.data?.reports?.find(r => r.reportedId === photoUserId);
  check('the report appears in the admin queue', Boolean(filed));
  check('the queue names the reporter and reported user (admin-only visibility)',
    Boolean(filed?.reporterName && filed?.reportedName));

  if (filed) {
    const resolve = await call(`/v1/admin/reports/${filed.id}/resolve`, {
      method: 'POST', token: adminToken,
    });
    check('resolving a report succeeds', resolve.status === 204);
  }

  console.log('\n== admin page ==');
  const page = await call('/admin');
  check('the admin page is served', page.status === 200);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
};

run().catch(err => {
  console.error('admin test crashed:', err);
  process.exit(1);
});
