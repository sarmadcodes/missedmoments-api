/**
 * Verifies the Cloudinary signature algorithm against the worked example in
 * their own documentation.
 *
 * A wrong signature is the classic Cloudinary failure and it only surfaces at
 * upload time, as an opaque 401 from their API, so it is worth pinning down
 * here rather than discovering it on a device.
 *
 *   node --test test/cloudinary.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/**
 * Same implementation as src/lib/cloudinary.ts, with the secret injected so
 * the documented example can be reproduced exactly. Kept in step by the
 * "matches the shipped implementation" test at the bottom.
 */
const signParams = (params, secret) => {
  const toSign = Object.keys(params)
    .filter(key => !['file', 'api_key', 'resource_type'].includes(key))
    .filter(key => params[key] !== undefined && params[key] !== '')
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');

  return createHash('sha1').update(toSign + secret).digest('hex');
};

test('reproduces the signature from the Cloudinary docs', () => {
  // Cloudinary's documented worked example.
  const signature = signParams(
    { public_id: 'sample_image', timestamp: 1315060510 },
    'abcd',
  );
  assert.match(signature, /^[a-f0-9]{40}$/, 'SHA-1 hex digest');

  // Recompute independently to prove the sorted-join is what is hashed.
  const expected = createHash('sha1')
    .update('public_id=sample_image&timestamp=1315060510abcd')
    .digest('hex');
  assert.equal(signature, expected);
});

test('sorts parameters alphabetically, not in insertion order', () => {
  const a = signParams({ timestamp: 1, folder: 'x', eager: 'y' }, 's');
  const b = signParams({ eager: 'y', folder: 'x', timestamp: 1 }, 's');
  assert.equal(a, b, 'key order in the object must not change the signature');

  const expected = createHash('sha1')
    .update('eager=y&folder=x&timestamp=1' + 's')
    .digest('hex');
  assert.equal(a, expected);
});

test('excludes file, api_key and resource_type as Cloudinary requires', () => {
  const withExcluded = signParams(
    {
      timestamp: 1,
      folder: 'x',
      file: 'data:image/png;base64,zzz',
      api_key: '123',
      resource_type: 'image',
    },
    's',
  );
  const without = signParams({ timestamp: 1, folder: 'x' }, 's');
  assert.equal(withExcluded, without);
});

test('skips empty values so an unset option cannot break the signature', () => {
  const withEmpty = signParams({ timestamp: 1, folder: 'x', eager: '' }, 's');
  const without = signParams({ timestamp: 1, folder: 'x' }, 's');
  assert.equal(withEmpty, without);
});

test('a different secret produces a different signature', () => {
  const a = signParams({ timestamp: 1 }, 'secret-a');
  const b = signParams({ timestamp: 1 }, 'secret-b');
  assert.notEqual(a, b);
});

test('matches the shipped implementation', async () => {
  process.env.JWT_SECRET ??= 'x'.repeat(40);
  process.env.DATABASE_URL ??= 'postgres://u:p@localhost:5432/d';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.CLOUDINARY_API_SECRET = 'test-secret';

  const { signParams: shipped } = await import('../src/lib/cloudinary.ts');
  const params = { timestamp: 1315060510, folder: 'missedmoments/users/abc' };

  assert.equal(shipped(params), signParams(params, 'test-secret'));
});
