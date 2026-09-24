import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPushHandlers, notificationFromPayload } from '../src/sw.js';

test('payload JSON becomes a notification; text becomes the body', () => {
  const n = notificationFromPayload(JSON.stringify({ title: 'Live', body: 'Go', url: '/c/x', tag: 't' }), { icon: '/i.png' });
  assert.equal(n.title, 'Live');
  assert.equal(n.options.body, 'Go');
  assert.equal(n.options.icon, '/i.png');
  assert.equal(n.options.data.url, '/c/x');
  assert.equal(n.options.renotify, true);
  assert.equal(notificationFromPayload('plain words').options.body, 'plain words');
});

function fakeScope(windows = []) {
  const handlers = {};
  const shown = [];
  const opened = [];
  return {
    handlers,
    shown,
    opened,
    location: { origin: 'https://pairux.com' },
    addEventListener: (type, fn) => (handlers[type] = fn),
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => opened.push(url),
    },
  };
}

test('push shows a notification; click focuses or opens the page', async () => {
  const scope = fakeScope();
  installPushHandlers(scope, { title: 'PairUX' });
  let waited;
  scope.handlers.push({ data: { text: () => '{"body":"hi","url":"/analyses/1"}' }, waitUntil: (p) => (waited = p) });
  await waited;
  assert.equal(scope.shown[0].title, 'PairUX');

  scope.handlers.notificationclick({
    notification: { close() {}, data: { url: '/analyses/1' } },
    waitUntil: (p) => (waited = p),
  });
  await waited;
  assert.deepEqual(scope.opened, ['https://pairux.com/analyses/1']);

  let focused = false;
  const open = fakeScope([{ url: 'https://pairux.com/analyses/1', focus: () => (focused = true) }]);
  installPushHandlers(open);
  open.handlers.notificationclick({ notification: { close() {}, data: { url: '/analyses/1' } }, waitUntil: (p) => (waited = p) });
  await waited;
  assert.equal(focused, true);
});
