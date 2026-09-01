import { createHash } from 'node:crypto';
import { request } from 'undici';
import { config } from '../config.js';
import { badRequest } from './errors.js';

/**
 * Cloudinary, signed-upload style.
 *
 * The app never sees the API secret. It asks this service for a signature,
 * uploads the file straight to Cloudinary, then tells us the resulting
 * public_id. Image bytes never pass through this server, which keeps uploads
 * fast and off our bandwidth bill.
 *
 * Implemented against the REST API directly rather than pulling in the SDK:
 * the signature is a sorted-param SHA-1 and the two calls we need are trivial,
 * so the dependency is not worth it.
 */

export const isConfigured = () =>
  Boolean(
    config.CLOUDINARY_CLOUD_NAME &&
      config.CLOUDINARY_API_KEY &&
      config.CLOUDINARY_API_SECRET,
  );

const assertConfigured = () => {
  if (!isConfigured()) {
    throw badRequest(
      'MEDIA_NOT_CONFIGURED',
      'Image uploads are not configured on this server',
    );
  }
};

/**
 * Cloudinary signs the alphabetically sorted `key=value` pairs joined by `&`,
 * with the API secret appended. `file`, `api_key` and `resource_type` are
 * excluded by their spec.
 */
export const signParams = (params: Record<string, string | number>) => {
  const toSign = Object.keys(params)
    .filter(key => !['file', 'api_key', 'resource_type'].includes(key))
    .filter(key => params[key] !== undefined && params[key] !== '')
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');

  return createHash('sha1')
    .update(toSign + config.CLOUDINARY_API_SECRET)
    .digest('hex');
};

export type UploadTicket = {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  uploadUrl: string;
  /** Constraints the client should enforce before wasting an upload. */
  maxBytes: number;
  allowedFormats: string[];
};

/**
 * A short-lived ticket the app uses to upload one image.
 *
 * `folder` is namespaced per user so someone cannot overwrite another user's
 * assets, and an incoming transformation caps dimensions server-side so a
 * 12MP phone photo does not become a 12MP download for every viewer.
 */
export const createUploadTicket = (userId: string): UploadTicket => {
  assertConfigured();

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `missedmoments/users/${userId}`;

  // Must match exactly what the client sends, or Cloudinary rejects the
  // signature.
  const signedParams: Record<string, string | number> = {
    timestamp,
    folder,
    transformation: 'c_limit,w_1440,h_1440,q_auto:good',
  };

  return {
    cloudName: config.CLOUDINARY_CLOUD_NAME,
    apiKey: config.CLOUDINARY_API_KEY,
    timestamp,
    signature: signParams(signedParams),
    folder,
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/image/upload`,
    maxBytes: 10 * 1024 * 1024,
    allowedFormats: ['jpg', 'jpeg', 'png', 'webp', 'heic'],
  };
};

/**
 * Confirms an asset really exists and belongs to this user's folder.
 *
 * The client reports its own public_id after uploading, so without this a
 * caller could claim any asset in the account -- including someone else's
 * photo -- as their own.
 */
export const verifyAsset = async (publicId: string, userId: string) => {
  assertConfigured();

  const expectedPrefix = `missedmoments/users/${userId}/`;
  if (!publicId.startsWith(expectedPrefix)) {
    throw badRequest('BAD_ASSET', 'That asset does not belong to you');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signParams({ public_id: publicId, timestamp });

  const params = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: config.CLOUDINARY_API_KEY,
    signature,
  });

  const res = await request(
    `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/resources/image/upload/${encodeURIComponent(publicId)}?${params}`,
    {
      method: 'GET',
      headers: { Authorization: basicAuth() },
      headersTimeout: 8000,
      bodyTimeout: 8000,
    },
  );

  if (res.statusCode !== 200) {
    throw badRequest('ASSET_NOT_FOUND', 'That upload could not be verified');
  }

  const body = (await res.body.json()) as {
    secure_url?: string;
    width?: number;
    height?: number;
    bytes?: number;
    format?: string;
  };

  if (!body.secure_url) {
    throw badRequest('ASSET_NOT_FOUND', 'That upload could not be verified');
  }

  return {
    url: body.secure_url,
    width: body.width ?? null,
    height: body.height ?? null,
    bytes: body.bytes ?? null,
    format: body.format ?? null,
  };
};

const basicAuth = () =>
  'Basic ' +
  Buffer.from(
    `${config.CLOUDINARY_API_KEY}:${config.CLOUDINARY_API_SECRET}`,
  ).toString('base64');

/** Permanently removes an asset from Cloudinary. */
export const destroyAsset = async (publicId: string) => {
  assertConfigured();

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signParams({ public_id: publicId, timestamp });

  const res = await request(
    `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/image/destroy`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        public_id: publicId,
        timestamp: String(timestamp),
        api_key: config.CLOUDINARY_API_KEY,
        signature,
      }).toString(),
      headersTimeout: 8000,
      bodyTimeout: 8000,
    },
  );

  const body = (await res.body.json()) as { result?: string };
  // "not found" is fine: the goal is that it is gone.
  return body.result === 'ok' || body.result === 'not found';
};

/**
 * A display URL with a transformation applied, so lists can request a small
 * image instead of downloading the full-size original.
 */
export const thumbUrl = (url: string, width = 400) =>
  url.replace('/upload/', `/upload/c_fill,g_auto,w_${width},h_${width},q_auto,f_auto/`);
