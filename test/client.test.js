import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateVapidKeys } from '../src/server.js';
import {
  PushError,
  clearKeyCache,
  getVapidPublicKey,
  pushSupport,
  subscribe,
  unsubscribe,
  urlBase64ToUint8Array,
} from '../src/client.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

function browser({ push = true, notification = 'default', secure = true, ua = 'Chrome', standalone = false, keyEndpoint } = {}) {
  const pushManager = {
    current: null,
    async getSubscription() {
      return this.current;
    },
    async subscribe({ applicationServerKey }) {
      this.current = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/xyz',
        options: { applicationServerKey: applicationServerKey.buffer },
        unsubscribed: false,
        async unsubscribe() {
          this.unsubscribed = true;
          pushManager.current = null;
          return true;
        },
        toJSON() {
          return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } };
        },
      };
      return this.current;
    },
  };
  const registration = { pushManager };
  const calls = [];
  const env = {
    isSecureContext: secure,
    navigator: {
      userAgent: ua,
      standalone,
      serviceWorker: {
        registered: null,
        async getRegistration() {
          return this.registered;
        },
        async register(url) {
          this.registered = registration;
          calls.push(['register', url]);
          return registration;
        },
        get ready() {
          return Promise.resolve(registration);
        },
      },
    },
    matchMedia: () => ({ matches: standalone }),
    fetch: async (url, init) => {
      calls.push([init?.method ?? 'GET', url, init?.body]);
      if (url === '/api/push/vapid-public-key') {
        return keyEndpoint ? keyEndpoint() : new Response(JSON.stringify({ publicKey: generateVapidKeys().publicKey }));
      }
      return new Response('{}', { status: 201 });
    },
  };
  if (push) env.PushManager = function PushManager() {};
  if (notification !== null) {
    env.Notification = {
      permission: notification,
      async requestPermission() {
        return (this.permission = notification === 'default' ? 'granted' : notification);
      },
    };
  }
  return { env, calls, pushManager };
}

beforeEach(() => {
  clearKeyCache();
});

test('pushSupport names the reason', () => {
  assert.equal(pushSupport(browser().env).supported, true);
  assert.equal(pushSupport(browser({ secure: false }).env).reason, 'insecure-context');
  assert.equal(pushSupport(browser({ push: false, ua: IPHONE }).env).reason, 'ios-needs-install');
  assert.equal(pushSupport(browser({ push: false }).env).reason, 'no-push-manager');
  assert.equal(pushSupport(browser({ notification: null }).env).reason, 'no-notification');
  assert.equal(pushSupport(browser({ notification: 'denied' }).env).reason, 'denied');
  const { env } = browser();
  delete env.navigator.serviceWorker;
  assert.equal(pushSupport(env).reason, 'no-service-worker');
  assert.match(pushSupport(browser({ push: false, ua: IPHONE }).env).message, /Home Screen/);
});

test('getVapidPublicKey reads JSON or text and refuses a missing key', async () => {
  const key = generateVapidKeys().publicKey;
  assert.equal(await getVapidPublicKey({ url: '/k1', fetch: async () => new Response(JSON.stringify({ publicKey: key })) }), key);
  assert.equal(await getVapidPublicKey({ url: '/k2', fetch: async () => new Response(key) }), key);
  await assert.rejects(
    getVapidPublicKey({ url: '/k3', fetch: async () => new Response('{"publicKey":null}', { status: 503 }) }),
    (e) => e instanceof PushError && e.reason === 'no-server-key'
  );
});

test('subscribe: permission, runtime key, registration, save', async () => {
  const { env, calls } = browser();
  const json = await subscribe({ env, saveUrl: '/api/push/subscribe' });
  assert.equal(json.endpoint, 'https://fcm.googleapis.com/fcm/send/xyz');
  assert.deepEqual(calls[0], ['GET', '/api/push/vapid-public-key', undefined]);
  assert.deepEqual(calls[1], ['register', '/sw.js']);
  assert.equal(calls[2][0], 'POST');
  assert.equal(calls[2][1], '/api/push/subscribe');
});

test('subscribe replaces a subscription made with an old key', async () => {
  const { env, pushManager } = browser();
  await subscribe({ env, vapidPublicKey: generateVapidKeys().publicKey });
  const old = pushManager.current;
  await subscribe({ env, vapidPublicKey: generateVapidKeys().publicKey });
  assert.equal(old.unsubscribed, true);
  assert.notEqual(pushManager.current, old);
});

test('subscribe throws PushError with the reason', async () => {
  await assert.rejects(subscribe({ env: browser({ push: false, ua: IPHONE }).env }), (e) => e.reason === 'ios-needs-install');
  await assert.rejects(subscribe({ env: browser({ notification: 'denied' }).env }), (e) => e.reason === 'denied');
  await assert.rejects(
    subscribe({ env: browser({ keyEndpoint: () => new Response('', { status: 503 }) }).env }),
    (e) => e.reason === 'no-server-key'
  );
});

test("subscribe names Chromium's AbortError instead of echoing it", async () => {
  const failing = (message, brave = false) => {
    const { env, pushManager } = browser();
    if (brave) env.navigator.brave = {};
    pushManager.subscribe = async () => {
      throw new DOMException(message, 'AbortError');
    };
    return subscribe({ env, vapidPublicKey: generateVapidKeys().publicKey });
  };
  // ungoogled Chromium: no push service at all
  await assert.rejects(failing('Registration failed - push service error'), (e) => e.reason === 'no-push-service');
  // Brave with "Use Google services for push messaging" off
  await assert.rejects(
    failing('Registration failed - push service error', true),
    (e) => e.reason === 'brave-push-off' && /brave:\/\/settings\/privacy/.test(e.message)
  );
  // Chromium's refused permission is also an AbortError
  await assert.rejects(failing('Registration failed - permission denied'), (e) => e.reason === 'denied');
});

test('unsubscribe tells the server', async () => {
  const { env, calls } = browser();
  await subscribe({ env, vapidPublicKey: generateVapidKeys().publicKey });
  assert.equal(await unsubscribe({ env, removeUrl: '/api/push/subscribe' }), true);
  assert.equal(calls.at(-1)[0], 'DELETE');
  assert.equal(await unsubscribe({ env }), false);
});

test('urlBase64ToUint8Array decodes a VAPID key to 65 bytes', () => {
  assert.equal(urlBase64ToUint8Array(generateVapidKeys().publicKey).length, 65);
});
