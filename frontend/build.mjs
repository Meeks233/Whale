// Build the Whale web UI: bundle + minify the TypeScript sources and CSS from
// src/ into ../web, the directory the Rust backend embeds (rust-embed) and the
// Tauri app ships verbatim (frontendDist). The committed artifacts in ../web are
// what actually run — re-run `npm run build` after editing anything in src/.
//
//   src/app.ts (+ src/i18n.ts)  ->  ../web/app.js   (one bundled, minified file)
//   src/sw.ts                   ->  ../web/sw.js     (service worker)
//   src/style.css               ->  ../web/style.css (minified)
//
// No framework, no runtime deps — esbuild only, so the output stays a plain
// IIFE that runs directly in the browser and the WebView with zero shims.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => resolve(here, 'src', p);
const out = (p) => resolve(here, '..', 'web', p);

const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2019'],
  legalComments: 'none',
  logLevel: 'info',
};

await Promise.all([
  // App bundle: app.ts imports i18n.ts for its side effect (window.i18n), so the
  // two former <script>s collapse into one request.
  build({ ...common, entryPoints: [src('app.ts')], outfile: out('app.js') }),
  // Service worker: bundled separately so it keeps its own top-level scope.
  build({ ...common, entryPoints: [src('sw.ts')], outfile: out('sw.js') }),
  // Stylesheet: esbuild minifies CSS (whitespace, longhand collapse, dead rules).
  build({ ...common, entryPoints: [src('style.css')], outfile: out('style.css'), loader: { '.css': 'css' } }),
]);

console.log('web/ assets built (app.js, sw.js, style.css)');
