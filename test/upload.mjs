/**
 * End-to-end image upload test against the real Cloudinary account.
 *
 * Exercises exactly what the app does: request a signed ticket, upload the
 * bytes straight to Cloudinary, register the asset, confirm it is served, then
 * delete it and confirm it is gone.
 *
 *   node test/upload.mjs
 *
 * Requires the API running with CLOUDINARY_* set.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://localhost:4100';
const EMAIL = process.env.EMAIL ?? 'demo@missedmoments.test';
const PASSWORD = process.env.PASSWORD ?? 'demo-password-123';

// A real photo from the app's own assets.
const IMAGE =
  process.env.IMAGE ??
  'C:/Users/H.H/Desktop/MissedMoments/src/assets/images/overlay1.png';

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
  return { status: res.status, data: text ? JSON.parse(text) : null };
};

const run = async () => {
  console.log('\n== setup ==');
  const login = await call('/v1/auth/login', {
    method: 'POST',
    body: { email: EMAIL, password: PASSWORD },
  });
  check('signed in', login.status === 200, JSON.stringify(login.data));
  const token = login.data.accessToken;

  const status = await call('/v1/media/status', { token });
  check('uploads are configured', status.data?.uploadsEnabled === true,
    JSON.stringify(status.data));
  if (!status.data?.uploadsEnabled) {
    console.log('\nCLOUDINARY_* not set on the running server. Stopping.\n');
    process.exit(1);
  }

  console.log('\n== signed ticket ==');
  const ticket = await call('/v1/media/upload-ticket', { method: 'POST', token });
  check('got an upload ticket', ticket.status === 200, JSON.stringify(ticket.data));
  const t = ticket.data;
  check('ticket carries a signature', Boolean(t?.signature));
  check('folder is namespaced to this user',
    t?.folder === `missedmoments/users/${login.data.userId}`, t?.folder);
  check('ticket does NOT leak the api secret',
    !JSON.stringify(t).toLowerCase().includes('secret'));

  console.log('\n== direct upload to Cloudinary ==');
  const bytes = await readFile(IMAGE);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/png' }), 'test-upload.png');
  form.append('api_key', t.apiKey);
  form.append('timestamp', String(t.timestamp));
  form.append('signature', t.signature);
  form.append('folder', t.folder);
  form.append('transformation', 'c_limit,w_1440,h_1440,q_auto:good');

  const up = await fetch(t.uploadUrl, { method: 'POST', body: form });
  const upBody = await up.json();
  check('Cloudinary accepted the signature', up.status === 200,
    JSON.stringify(upBody?.error ?? upBody).slice(0, 200));
  if (up.status !== 200) {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }
  check('got a public_id back', Boolean(upBody.public_id));
  check('asset landed in this user\'s folder',
    upBody.public_id.startsWith(t.folder), upBody.public_id);
  check('image was capped at 1440px',
    upBody.width <= 1440 && upBody.height <= 1440,
    `${upBody.width}x${upBody.height}`);
  console.log(`        -> ${upBody.secure_url}`);

  console.log('\n== register with the API ==');
  const registered = await call('/v1/media/photos', {
    method: 'POST', token, body: { publicId: upBody.public_id },
  });
  check('photo registered', registered.status === 201, JSON.stringify(registered.data));
  check('returns a served URL', Boolean(registered.data?.url));
  const photoId = registered.data?.id;

  const me = await call('/v1/users/me', { token });
  check('/users/me now returns the avatar', Boolean(me.data?.photoUrl),
    String(me.data?.photoUrl));

  const profile = await call(`/v1/users/${login.data.userId}`, { token });
  check('public profile lists the photo',
    (profile.data?.photos ?? []).length > 0,
    JSON.stringify(profile.data?.photos));

  console.log('\n== the image is actually served ==');
  const fetched = await fetch(registered.data.url);
  check('URL returns 200', fetched.status === 200, `got ${fetched.status}`);
  check('served as an image',
    (fetched.headers.get('content-type') ?? '').startsWith('image/'),
    fetched.headers.get('content-type'));

  console.log('\n== ownership is enforced ==');
  const stolen = await call('/v1/media/photos', {
    method: 'POST', token,
    body: { publicId: 'missedmoments/users/00000000-0000-0000-0000-000000000000/x' },
  });
  check('cannot claim another user\'s asset', stolen.status === 400,
    `got ${stolen.status}`);

  const bogus = await call('/v1/media/photos', {
    method: 'POST', token, body: { publicId: `${t.folder}/does-not-exist` },
  });
  check('cannot register an asset that was never uploaded', bogus.status === 400,
    `got ${bogus.status}`);

  console.log('\n== delete ==');
  const removed = await call(`/v1/media/photos/${photoId}`, {
    method: 'DELETE', token,
  });
  check('photo deleted', removed.status === 204, `got ${removed.status}`);

  const after = await call('/v1/media/photos', { token });
  check('photo is gone from the account',
    !(after.data?.photos ?? []).some(p => p.id === photoId));

  // Ask Cloudinary's Admin API, not the CDN edge. A cached edge copy can keep
  // returning 200 after a successful delete, so the edge is not the source of
  // truth for whether the asset is gone. (destroyAsset also passes
  // invalidate=true to start purging those caches, but that is best-effort and
  // can take up to an hour, so it is not something a test can wait on.)
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (cloudName && apiKey && apiSecret) {
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    const url = `https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload/${encodeURIComponent(upBody.public_id)}`;

    // The API returns 204 as soon as the row is gone and fires the Cloudinary
    // delete without awaiting it, so that a slow CDN never blocks someone
    // removing their own photo. That means polling here rather than checking
    // once -- a single immediate check races the background request.
    let status = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const admin = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      status = admin.status;
      if (status === 404) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    check('asset is gone from Cloudinary itself', status === 404, `got ${status}`);
  } else {
    console.log('  SKIP  asset removal (set CLOUDINARY_* to verify via the Admin API)');
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
};

run().catch(err => {
  console.error('upload test crashed:', err);
  process.exit(1);
});
