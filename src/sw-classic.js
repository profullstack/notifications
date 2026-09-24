// GENERATED from src/sw.js by scripts/build-sw-classic.js. Do not edit.
// For a classic (non-module) service worker:
//   importScripts('/vendor/notifications-sw.js');
//   self.PushHandlers.installPushHandlers(self, { icon: '/icon-192.png' });
(function (global) {
  /**
   * Service worker side: show pushes and open the right page on click.
   *
   *   // sw.js (module or bundled)
   *   import { installPushHandlers } from '@profullstack/notifications/sw';
   *   installPushHandlers(self, { icon: '/icon-192.png' });
   *
   * Payloads are JSON { title, body, url?, icon?, badge?, tag?, data? } (what
   * the server sends); a plain-text payload becomes the body.
   */

  /** Notification options from a push payload. */
  function notificationFromPayload(text, defaults = {}) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { body: text };
    }
    if (typeof data !== 'object' || data === null) data = { body: String(data) };
    const title = data.title || defaults.title || 'Notification';
    return {
      title,
      options: {
        body: data.body ?? '',
        icon: data.icon ?? defaults.icon,
        badge: data.badge ?? defaults.badge,
        tag: data.tag,
        renotify: Boolean(data.tag),
        data: { url: data.url ?? defaults.url ?? '/', ...(data.data ?? {}) },
      },
    };
  }

  /** Install `push` and `notificationclick` handlers on a service worker scope. */
  function installPushHandlers(scope, defaults = {}) {
    scope.addEventListener('push', (event) => {
      const text = event.data ? event.data.text() : '';
      const { title, options } = notificationFromPayload(text, defaults);
      event.waitUntil(scope.registration.showNotification(title, options));
    });

    scope.addEventListener('notificationclick', (event) => {
      event.notification.close();
      const target = new URL(event.notification.data?.url ?? '/', scope.location.origin).href;
      event.waitUntil(
        (async () => {
          const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
          const same = windows.find((w) => w.url === target);
          if (same) return same.focus();
          const any = windows.find((w) => new URL(w.url).origin === scope.location.origin);
          if (any && 'navigate' in any) {
            await any.navigate(target);
            return any.focus();
          }
          return scope.clients.openWindow(target);
        })()
      );
    });
  }

  global.PushHandlers = { installPushHandlers, notificationFromPayload };
})(typeof self !== 'undefined' ? self : globalThis);
