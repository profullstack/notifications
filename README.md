# @profullstack/notifications

Web Push that works the first time, in every app.

- **Zero dependencies.** VAPID (RFC 8292) and message encryption (RFC 8291) come straight from `node:crypto`. Keys are in the same format as the `web-push` package, so you can switch without regenerating anything.
- **The public key is fetched at runtime.** The most common way push breaks in production is a `NEXT_PUBLIC_VAPID_PUBLIC_KEY` that was missing when the client bundle was built. It compiles to an empty string, and every browser then reports "push notifications are not supported". Here the browser asks your server for the key when it subscribes.
- **"Not supported" always comes with a reason.** `pushSupport()` tells you which one it is, with a sentence to show the user:
  - not on HTTPS;
  - iPhone or iPad without the site added to the Home Screen;
  - notifications blocked in the browser's settings;
  - no service worker support;
  - the server has no key configured.

```sh
npm install @profullstack/notifications
```

## Server

```js
import {
  vapidKeysFromEnv,
  vapidPublicKeyResponse,
  parseSubscription,
  sendPushToMany,
} from '@profullstack/notifications/server';

const keys = vapidKeysFromEnv(); // VAPID_PUBLIC_KEY (or NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PUBLIC) + VAPID_PRIVATE_KEY (or VAPID_PRIVATE), read at run time

// GET /api/push/vapid-public-key
export const GET = () => vapidPublicKeyResponse(keys);

// POST /api/push/subscribe
const subscription = parseSubscription(await request.json()); // null if malformed
// ...store it against the user...

// Sending
await sendPushToMany(userSubscriptions, { title: 'You are live', body: 'Tap to open', url: '/live' }, {
  keys,
  subject: 'mailto:hello@example.com',
  onGone: (endpoint) => db.deleteSubscription(endpoint), // 404/410 from the push service
});
```

Messages the push service can't deliver yet are kept for `ttl` seconds, 24 hours by default. The `web-push` package defaulted to 4 weeks, so pass `ttl: 28 * 24 * 3600` when migrating if late delivery matters.

New keys: `node -e "import('@profullstack/notifications/server').then(m => console.log(m.generateVapidKeys()))"`.

## Browser

```js
import { pushSupport, subscribe, unsubscribe } from '@profullstack/notifications/client';

const support = pushSupport();
if (!support.supported) showMessage(support.message); // e.g. the iPhone Home Screen instructions

button.onclick = async () => {
  try {
    await subscribe({ saveUrl: '/api/push/subscribe' }); // asks permission, fetches the key, registers /sw.js if needed
  } catch (error) {
    showMessage(error.message); // error.reason: 'denied' | 'no-server-key' | ...
  }
};
```

`subscribe()` replaces a subscription that was made with a different key, so rotating keys doesn't silently stop delivery.

## Service worker

```js
import { installPushHandlers } from '@profullstack/notifications/sw';
installPushHandlers(self, { icon: '/icon-192.png' });
```

It shows `{ title, body, url, icon, tag }` payloads. Clicking a notification focuses a tab already on that URL, or opens one.

## License

MIT
