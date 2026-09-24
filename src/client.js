/**
 * Web Push in the browser: say exactly why push is unavailable, fetch the
 * server's VAPID key at runtime, and subscribe.
 *
 * Two bugs this exists to end:
 *   1. "Push notifications are not supported in this browser" shown to a
 *      browser that supports them fine, because the app's public key was
 *      compiled into the bundle and was empty in that build. Here the key is
 *      fetched from the server when it is needed.
 *   2. A generic "not supported" that hides the real reason: not HTTPS, iOS
 *      needing the site added to the Home Screen, notifications blocked in
 *      settings. pushSupport() names the reason and says what to do.
 */

/** @type {Record<string, string>} */
export const REASON_MESSAGES = {
  'no-window': 'Push notifications are only available in a browser.',
  'insecure-context': 'Push notifications need a secure (https://) connection.',
  'no-service-worker': 'This browser does not support service workers, which push notifications need.',
  'ios-needs-install':
    'On iPhone and iPad, add this site to your Home Screen (Share, then "Add to Home Screen") and open it from there to get notifications.',
  'no-push-manager': 'This browser does not support push notifications.',
  'no-notification': 'This browser does not support notifications.',
  denied: 'Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.',
  'no-server-key': 'Push notifications are not set up on this server yet.',
};

function isIOS(nav) {
  const ua = nav?.userAgent ?? '';
  // iPadOS reports itself as a Mac; touch support gives it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);
}

function isStandalone(win) {
  return (
    win?.navigator?.standalone === true ||
    (typeof win?.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches)
  );
}

/**
 * Whether this browser can receive push right now, and if not, why.
 * Returns { supported, reason, message, permission }. `supported` is true when
 * subscribing can work (permission may still be 'default' = not asked yet).
 * `env` is injectable for tests; pass nothing in the browser.
 */
export function pushSupport(env = globalThis) {
  const win = env;
  const nav = env?.navigator;
  const fail = (reason) => ({ supported: false, reason, message: REASON_MESSAGES[reason], permission: permissionOf(win) });
  if (!win || !nav) return fail('no-window');
  if (win.isSecureContext === false) return fail('insecure-context');
  if (!('serviceWorker' in nav)) return fail('no-service-worker');
  if (!('PushManager' in win)) return fail(isIOS(nav) && !isStandalone(win) ? 'ios-needs-install' : 'no-push-manager');
  if (!('Notification' in win)) return fail('no-notification');
  if (win.Notification.permission === 'denied') return fail('denied');
  return { supported: true, reason: null, message: null, permission: win.Notification.permission };
}

function permissionOf(win) {
  return win && 'Notification' in win ? win.Notification.permission : 'unsupported';
}

/** An error with a machine-readable reason (see REASON_MESSAGES). */
export class PushError extends Error {
  constructor(reason, message) {
    super(message ?? REASON_MESSAGES[reason] ?? reason);
    this.name = 'PushError';
    this.reason = reason;
  }
}

const keyCache = new Map();

/**
 * The server's VAPID public key, fetched at runtime from `url` (default
 * /api/push/vapid-public-key). Accepts a JSON body { publicKey } or plain text.
 */
export async function getVapidPublicKey({ url = '/api/push/vapid-public-key', fetch: doFetch = globalThis.fetch } = {}) {
  if (keyCache.has(url)) return keyCache.get(url);
  const response = await doFetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new PushError('no-server-key');
  const text = (await response.text()).trim();
  let key = text;
  try {
    key = JSON.parse(text).publicKey ?? '';
  } catch {
    // plain-text key
  }
  if (!key || !/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(key)) throw new PushError('no-server-key');
  keyCache.set(url, key);
  return key;
}

/** @internal exposed for tests */
export function clearKeyCache() {
  keyCache.clear();
}

export function urlBase64ToUint8Array(base64) {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a, b) {
  if (!a || !b) return false;
  const x = new Uint8Array(a);
  if (x.length !== b.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== b[i]) return false;
  return true;
}

async function registrationFor({ serviceWorkerUrl, scope, env }) {
  const container = env.navigator.serviceWorker;
  const existing = await container.getRegistration(scope);
  if (!existing) await container.register(serviceWorkerUrl, scope ? { scope } : undefined);
  return container.ready;
}

/**
 * Ask permission (call from a click handler), subscribe, and hand the
 * subscription to your server.
 *
 * Options:
 *   vapidPublicKey     the key, if you already have it; otherwise…
 *   vapidKeyUrl        …where to fetch it (default /api/push/vapid-public-key)
 *   serviceWorkerUrl   registered if no worker controls the scope (default /sw.js)
 *   scope              service worker scope
 *   saveUrl            POST the subscription JSON here (optional)
 *   save               or a function to call with it (optional)
 *   headers            extra headers for saveUrl (e.g. Authorization)
 *
 * Resolves to the subscription JSON. Throws PushError with a `reason`.
 */
export async function subscribe(options = {}) {
  const env = options.env ?? globalThis;
  const doFetch = options.fetch ?? env.fetch?.bind(env) ?? globalThis.fetch;
  const support = pushSupport(env);
  if (!support.supported) throw new PushError(support.reason);

  const permission =
    env.Notification.permission === 'granted' ? 'granted' : await env.Notification.requestPermission();
  if (permission !== 'granted') throw new PushError('denied');

  const publicKey =
    options.vapidPublicKey || (await getVapidPublicKey({ url: options.vapidKeyUrl, fetch: doFetch }));
  const applicationServerKey = urlBase64ToUint8Array(publicKey);

  const registration = await registrationFor({
    serviceWorkerUrl: options.serviceWorkerUrl ?? '/sw.js',
    scope: options.scope,
    env,
  });

  let subscription = await registration.pushManager.getSubscription();
  // A subscription made with another key (keys were rotated) cannot receive
  // pushes signed with this one: replace it.
  if (subscription && !sameKey(subscription.options?.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });

  const json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
  if (options.save) await options.save(json);
  if (options.saveUrl) {
    const res = await doFetch(options.saveUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: JSON.stringify(json),
      credentials: 'include',
    });
    if (!res.ok) throw new PushError('save-failed', `Could not save the subscription (${res.status})`);
  }
  return json;
}

/** The current subscription JSON, or null (no prompts, no side effects). */
export async function getSubscription({ scope, env = globalThis } = {}) {
  const support = pushSupport(env);
  if (!support.supported && support.reason !== 'denied') return null;
  const registration = await env.navigator.serviceWorker.getRegistration(scope);
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? subscription.toJSON() : null;
}

/**
 * Unsubscribe this browser. `removeUrl` (optional) receives DELETE with the
 * endpoint so the server can forget it. Resolves true when something was
 * unsubscribed.
 */
export async function unsubscribe({ scope, removeUrl, headers, env = globalThis, fetch: doFetch } = {}) {
  const registration = await env.navigator?.serviceWorker?.getRegistration(scope);
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  if (removeUrl) {
    await (doFetch ?? env.fetch.bind(env))(removeUrl, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
      body: JSON.stringify({ endpoint }),
      credentials: 'include',
    }).catch(() => undefined);
  }
  return true;
}
