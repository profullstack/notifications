/**
 * Web Push from the server, with node:crypto and nothing else.
 *
 * Web Push is two RFCs: 8291 says how a message is encrypted to the browser's
 * key (ECDH on P-256, HKDF, AES-128-GCM in the `aes128gcm` content encoding of
 * RFC 8188) and 8292 says how the sender proves who it is (VAPID: an ES256 JWT
 * over the push service's origin). Both fit here, so there is no dependency to
 * audit. Keys use the same base64url format as the `web-push` package, so an
 * app can switch without regenerating anything.
 *
 * Storage is the app's business: sendPush() takes a subscription and tells
 * you whether the push service says it is gone (404/410) so you can delete it.
 */

import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

const b64u = {
  encode: (bytes) => Buffer.from(bytes).toString('base64url'),
  decode: (text) => Buffer.from(String(text).replace(/=+$/, ''), 'base64url'),
};

/** A fresh VAPID pair: { publicKey, privateKey }, both base64url. */
export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: b64u.encode(pointOf(jwk.x, jwk.y)), privateKey: jwk.d };
}

/**
 * VAPID keys from the environment, read at RUN time. Accepts the usual names
 * (VAPID_PUBLIC_KEY / NEXT_PUBLIC_VAPID_PUBLIC_KEY / PUBLIC_VAPID_KEY and
 * VAPID_PRIVATE_KEY), so the same keys work whatever an app called them.
 * Returns null when either half is missing.
 */
export function vapidKeysFromEnv(env = process.env) {
  const get = (name) => (typeof env[name] === 'string' && env[name].trim() ? env[name].trim() : null);
  const publicKey =
    get('VAPID_PUBLIC_KEY') ?? get('NEXT_PUBLIC_VAPID_PUBLIC_KEY') ?? get('PUBLIC_VAPID_KEY');
  const privateKey = get('VAPID_PRIVATE_KEY') ?? get('PRIVATE_VAPID_KEY');
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey };
}

/**
 * The response for a public-key endpoint (e.g. GET /api/push/vapid-public-key).
 * Serving the key at runtime is the point of this package: a key baked into a
 * client bundle at build time is the most common reason push "is not
 * supported" in production.
 */
export function vapidPublicKeyResponse(keys) {
  const body = keys?.publicKey
    ? JSON.stringify({ publicKey: keys.publicKey })
    : JSON.stringify({ publicKey: null, error: 'Push is not configured on this server' });
  return new Response(body, {
    status: keys?.publicKey ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
  });
}

function pointOf(x, y) {
  return Buffer.concat([Buffer.from([0x04]), b64u.decode(x), b64u.decode(y)]);
}

function coordinatesOf(point) {
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('expected an uncompressed P-256 public key (65 bytes, base64url)');
  }
  return { x: b64u.encode(point.subarray(1, 33)), y: b64u.encode(point.subarray(33, 65)) };
}

function privateKeyOf(keys) {
  const { x, y } = coordinatesOf(b64u.decode(keys.publicKey));
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x, y, d: keys.privateKey }, format: 'jwk' });
}

function publicKeyOf(point) {
  const { x, y } = coordinatesOf(point);
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' });
}

/** RFC 8292: the value of the Authorization header, `vapid t=<jwt>, k=<key>`. */
export function vapidHeader(keys, audience, subject, now = Date.now()) {
  const header = b64u.encode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(
    Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }))
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: privateKeyOf(keys),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64u.encode(signature)}, k=${keys.publicKey}`;
}

/** A fresh ephemeral key and salt for one message. */
export function freshEphemeral() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { privateKey, publicKey: pointOf(jwk.x, jwk.y), salt: randomBytes(16) };
}

/**
 * RFC 8291 + RFC 8188: `plaintext` encrypted to one subscription.
 * `ephemeral` is injectable only so tests can check the bytes.
 */
export function encrypt(subscription, plaintext, ephemeral = freshEphemeral()) {
  const uaPublic = b64u.decode(subscription.keys.p256dh);
  const authSecret = b64u.decode(subscription.keys.auth);
  if (authSecret.length !== 16) throw new Error('the auth secret must be 16 bytes');

  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyOf(uaPublic) });
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, ephemeral.publicKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, ephemeral.salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, ephemeral.salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // One record: plaintext, the 0x02 last-record delimiter, then the GCM tag.
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.concat([ephemeral.salt, rs, Buffer.from([ephemeral.publicKey.length]), ephemeral.publicKey]);
  return Buffer.concat([header, body]);
}

/**
 * A browser PushSubscription (or its toJSON()) checked and normalised, or null.
 * Use it on whatever your "save subscription" endpoint receives.
 */
export function parseSubscription(input) {
  if (typeof input !== 'object' || input === null) return null;
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  const keys = typeof input.keys === 'object' && input.keys !== null ? input.keys : {};
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
  const auth = typeof keys.auth === 'string' ? keys.auth : '';
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000) return null;
  try {
    if (b64u.decode(p256dh).length !== 65 || b64u.decode(auth).length !== 16) return null;
  } catch {
    return null;
  }
  return { endpoint, keys: { p256dh, auth } };
}

/** The request for one subscription, ready for fetch(url, init). */
export function buildPushRequest(keys, subscription, payload, { subject, ttl = 24 * 3600, urgency = 'normal', topic } = {}) {
  if (!subject) throw new Error('subject is required: a mailto: address or https: URL (RFC 8292)');
  const audience = new URL(subscription.endpoint).origin;
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const body = encrypt(subscription, Buffer.from(text));
  const headers = {
    authorization: vapidHeader(keys, audience, subject),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(ttl),
    urgency,
  };
  if (topic) headers.topic = topic;
  return { url: subscription.endpoint, init: { method: 'POST', headers, body: new Uint8Array(body) } };
}

/**
 * Send one notification to one subscription.
 * Resolves to { endpoint, status, sent, gone, error }; never throws for a delivery
 * failure. `gone` means the push service says the subscription no longer
 * exists (404/410): delete it from your store.
 */
export async function sendPush(subscription, payload, { keys, subject, ttl, urgency, topic, fetch: doFetch = fetch, timeoutMs = 10_000 } = {}) {
  const result = { endpoint: subscription?.endpoint ?? '', status: null, sent: false, gone: false, error: null };
  try {
    if (!keys) throw new Error('VAPID keys are required');
    const { url, init } = buildPushRequest(keys, subscription, payload, { subject, ttl, urgency, topic });
    const response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    result.status = response.status;
    result.sent = response.ok;
    result.gone = response.status === 404 || response.status === 410;
    if (!response.ok && !result.gone) {
      // The push service's own words (FCM, Mozilla and Apple all explain a
      // rejected VAPID header or payload in the body), trimmed for logs.
      const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
      result.error = `push service answered ${response.status}${detail ? `: ${detail}` : ''}`;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/**
 * Send to many subscriptions (a user's devices, say). `onGone` is called for
 * each subscription the push service reports as gone, so you can delete it.
 */
export async function sendPushToMany(subscriptions, payload, options = {}) {
  const results = await Promise.all(subscriptions.map((s) => sendPush(s, payload, options)));
  if (options.onGone) {
    for (const r of results) if (r.gone) await options.onGone(r.endpoint);
  }
  return results;
}

/** A VAPID subject from an app's From address or URL: mailto:… when possible. */
export function pushSubject(mailFrom, publicUrl) {
  const address = /<([^>]+)>/.exec(mailFrom ?? '')?.[1] ?? mailFrom ?? '';
  if (/^[^@\s]+@[^@\s]+$/.test(address)) return `mailto:${address}`;
  return publicUrl;
}
