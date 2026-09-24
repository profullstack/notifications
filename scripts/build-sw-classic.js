// Builds src/sw-classic.js from src/sw.js for service workers that are plain
// scripts (registered without { type: 'module' }), which cannot `import`.
// Load it with importScripts('/path/to/sw-classic.js') and call
// self.PushHandlers.installPushHandlers(self, { ... }).
//
// Run: node scripts/build-sw-classic.js   (test/sw.test.js fails if it is stale)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/sw.js', import.meta.url));
const out = fileURLToPath(new URL('../src/sw-classic.js', import.meta.url));

export function buildClassic(source) {
  const body = source.replace(/^export (function|const|class) /gm, '$1 ').trimEnd();
  return `// GENERATED from src/sw.js by scripts/build-sw-classic.js. Do not edit.
// For a classic (non-module) service worker:
//   importScripts('/vendor/notifications-sw.js');
//   self.PushHandlers.installPushHandlers(self, { icon: '/icon-192.png' });
(function (global) {
${body.replace(/^(?=.)/gm, '  ')}

  global.PushHandlers = { installPushHandlers, notificationFromPayload };
})(typeof self !== 'undefined' ? self : globalThis);
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(out, buildClassic(readFileSync(src, 'utf8')));
  console.log('wrote src/sw-classic.js');
}
