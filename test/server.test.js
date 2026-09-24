import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify,
} from 'node:crypto';
import {
  buildPushRequest,
  encrypt,
  generateVapidKeys,
  parseSubscription,
  pushSubject,
  sendPush,
  sendPushToMany,
  vapidHeader,
  vapidKeysFromEnv,
  vapidPublicKeyResponse,
} from '../src/server.js';

const b64u = (b) => Buffer.from(b).toString('base64url');

/** A browser-side subscription with its private key, to decrypt what we send. */
function fakeBrowser() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const auth = randomBytes(16);
  return {
    privateKey,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: b64u(point), auth: b64u(auth) },
    },
  };
}

/** RFC 8291 decryption, as a browser does it. */
function decrypt(browser, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const serverPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const uaPublic = Buffer.from(browser.subscription.keys.p256dh, 'base64url');
  const auth = Buffer.from(browser.subscription.keys.auth, 'base64url');
  const serverKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(serverPublic.subarray(1, 33)), y: b64u(serverPublic.subarray(33, 65)) },
    format: 'jwk',
  });
  const shared = diffieHellman({ privateKey: browser.privateKey, publicKey: serverKey });
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, serverPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 0x02, 'last-record delimiter');
  return plain.subarray(0, plain.length - 1).toString();
}

test('encrypts so the browser can decrypt (RFC 8291)', () => {
  const browser = fakeBrowser();
  const body = encrypt(browser.subscription, Buffer.from('{"title":"hi"}'));
  assert.equal(decrypt(browser, body), '{"title":"hi"}');
});

test('VAPID header is an ES256 JWT the public key verifies', () => {
  const keys = generateVapidKeys();
  const value = vapidHeader(keys, 'https://fcm.googleapis.com', 'mailto:a@b.c', 1_700_000_000_000);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(value);
  assert.equal(k, keys.publicKey);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 43200, sub: 'mailto:a@b.c' });
  const point = Buffer.from(keys.publicKey, 'base64url');
  const pub = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) },
    format: 'jwk',
  });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('keys: generate, read from env at runtime, serve the public half', async () => {
  const keys = generateVapidKeys();
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
  assert.equal(Buffer.from(keys.privateKey, 'base64url').length, 32);
  assert.deepEqual(vapidKeysFromEnv({ NEXT_PUBLIC_VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey }), keys);
  assert.equal(vapidKeysFromEnv({ VAPID_PUBLIC_KEY: keys.publicKey }), null);
  const res = vapidPublicKeyResponse(keys);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { publicKey: keys.publicKey });
  assert.equal(vapidPublicKeyResponse(null).status, 503);
});

test('parseSubscription accepts real shapes and rejects junk', () => {
  const { subscription } = fakeBrowser();
  assert.deepEqual(parseSubscription({ ...subscription, expirationTime: null }), subscription);
  assert.equal(parseSubscription({ ...subscription, endpoint: 'http://insecure' }), null);
  assert.equal(parseSubscription({ endpoint: subscription.endpoint, keys: { p256dh: 'x', auth: 'y' } }), null);
  assert.equal(parseSubscription('nope'), null);
});

test('buildPushRequest requires a subject and sets the Web Push headers', () => {
  const keys = generateVapidKeys();
  const { subscription } = fakeBrowser();
  assert.throws(() => buildPushRequest(keys, subscription, { title: 't' }, {}), /subject/);
  const { url, init } = buildPushRequest(keys, subscription, { title: 't' }, { subject: 'mailto:a@b.c', ttl: 60, topic: 'x' });
  assert.equal(url, subscription.endpoint);
  assert.equal(init.headers['content-encoding'], 'aes128gcm');
  assert.equal(init.headers.ttl, '60');
  assert.equal(init.headers.topic, 'x');
  assert.match(init.headers.authorization, /^vapid t=/);
});

test('sendPush reports sent, gone and errors without throwing', async () => {
  const keys = generateVapidKeys();
  const { subscription } = fakeBrowser();
  const reply = (status) => async () => new Response(null, { status });
  assert.deepEqual(
    { ...(await sendPush(subscription, { title: 't' }, { keys, subject: 'mailto:a@b.c', fetch: reply(201) })), error: null },
    { endpoint: subscription.endpoint, status: 201, sent: true, gone: false, error: null }
  );
  const gone = await sendPush(subscription, 'hi', { keys, subject: 'mailto:a@b.c', fetch: reply(410) });
  const rejected = await sendPush(subscription, 'hi', {
    keys,
    subject: 'mailto:a@b.c',
    fetch: async () => new Response('invalid JWT provided', { status: 403 }),
  });
  assert.equal(rejected.error, 'push service answered 403: invalid JWT provided');
  const bare = await sendPush(subscription, 'hi', { keys, subject: 'mailto:a@b.c', fetch: reply(500) });
  assert.equal(bare.error, 'push service answered 500');
  assert.equal(gone.gone, true);
  const broken = await sendPush(subscription, 'hi', { keys, subject: 'mailto:a@b.c', fetch: async () => { throw new Error('offline'); } });
  assert.equal(broken.sent, false);
  assert.equal(broken.error, 'offline');
  const noKeys = await sendPush(subscription, 'hi', { subject: 'mailto:a@b.c' });
  assert.match(noKeys.error, /VAPID/);
});

test('sendPushToMany calls onGone for dead subscriptions', async () => {
  const keys = generateVapidKeys();
  const a = fakeBrowser().subscription;
  const b = { ...fakeBrowser().subscription, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/dead' };
  const removed = [];
  const results = await sendPushToMany([a, b], { title: 't' }, {
    keys,
    subject: 'mailto:a@b.c',
    fetch: async (url) => new Response(null, { status: url.includes('dead') ? 404 : 201 }),
    onGone: (endpoint) => removed.push(endpoint),
  });
  assert.equal(results.filter((r) => r.sent).length, 1);
  assert.deepEqual(removed, [b.endpoint]);
});

test('pushSubject prefers a mailto:', () => {
  assert.equal(pushSubject('PairUX <hello@pairux.com>', 'https://pairux.com'), 'mailto:hello@pairux.com');
  assert.equal(pushSubject('no address', 'https://pairux.com'), 'https://pairux.com');
});
