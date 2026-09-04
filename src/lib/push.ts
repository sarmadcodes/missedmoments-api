import { query } from './db.js';
import { config } from '../config.js';

/**
 * Push notifications, Android + iOS, both through Firebase Cloud Messaging.
 *
 * FCM delivers to APNs on Firebase's behalf for iOS devices, so this one
 * service account covers both platforms -- there is no separate APNs
 * cert/key path on the backend. The app still needs a real APNs setup
 * (a push-notification-enabled provisioning profile) so Firebase itself can
 * talk to Apple's servers, but that lives in the Apple Developer account and
 * Xcode, not here.
 *
 * Every function here is a no-op when FIREBASE_SERVICE_ACCOUNT_JSON is unset,
 * and every caller treats a push failure as non-fatal -- a match, a message,
 * a like all already work via the in-app notifications feed and the chat
 * WebSocket. Push is a notification of something that already happened, and
 * must never be a dependency for that something happening.
 */

// firebase-admin v13's modular API: firebase-admin/app for the app instance,
// firebase-admin/messaging for the messaging client. There is no monolithic
// `admin.messaging()` on the top-level package anymore.
type Messaging = import('firebase-admin/messaging').Messaging;

let messaging: Messaging | null = null;
let initTried = false;

export const isConfigured = () => Boolean(config.FIREBASE_SERVICE_ACCOUNT_JSON);

const getMessagingClient = async (): Promise<Messaging | null> => {
  if (!isConfigured()) return null;
  if (messaging) return messaging;
  if (initTried) return null; // parsing/initializing already failed once this process
  initTried = true;

  try {
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');

    const serviceAccount = JSON.parse(config.FIREBASE_SERVICE_ACCOUNT_JSON);
    const app = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount) });
    messaging = getMessaging(app);
    return messaging;
  } catch (err) {
    // A malformed FIREBASE_SERVICE_ACCOUNT_JSON must not crash the API --
    // it should behave exactly like push not being configured at all, with
    // this logged once so it's not a silent mystery.
    console.error('Push notifications misconfigured, disabling:', err);
    return null;
  }
};

export type PushPayload = {
  title: string;
  body: string;
  /** Delivered in the notification's `data` block for the app to route on tap. */
  data?: Record<string, string>;
};

/**
 * Sends a push to every device registered to a user. Invalid/unregistered
 * tokens (uninstalled app, expired token) are removed from device_tokens as
 * FCM reports them, so that table doesn't grow stale forever -- there was no
 * other code path that ever cleaned it.
 */
export const sendPushToUser = async (userId: string, payload: PushPayload) => {
  const fcm = await getMessagingClient();
  if (!fcm) return;

  const devices = await query<{ token: string }>(
    'SELECT token FROM device_tokens WHERE user_id = $1',
    [userId],
  );
  if (!devices.length) return;

  try {
    const result = await fcm.sendEachForMulticast({
      tokens: devices.map(d => d.token),
      notification: { title: payload.title, body: payload.body },
      data: payload.data ?? {},
      // Foreground/background/killed presentation for Android is controlled
      // by the channel the app itself creates (see the app's push setup);
      // this just sets a sensible default delivery priority.
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });

    const deadTokens: string[] = [];
    result.responses.forEach((r, i) => {
      const code = (r.error as { code?: string } | undefined)?.code;
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        const token = devices[i]?.token;
        if (token) deadTokens.push(token);
      }
    });

    if (deadTokens.length) {
      await query('DELETE FROM device_tokens WHERE token = ANY($1)', [deadTokens]);
    }
  } catch (err) {
    console.error('Push send failed (non-fatal):', err);
  }
};
