// Assemble the loadable extension into dist-ext/: bundle the strict TypeScript
// entry points with esbuild, then copy the manifest, static HTML, and icons.
// Mirrors ../frontend/build.ts so the two share one toolchain and one style.
import { build, type BuildOptions } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (path: string): string => resolve(here, 'src', path);
const dist = (path: string): string => resolve(here, 'dist-ext', path);

const common = {
  bundle: true,
  minify: true,
  target: ['firefox115', 'chrome110'],
  legalComments: 'eof',
  logLevel: 'info',
  // Dev-only auto-config seed (inert in a normal build: both default to ""). When
  // ORCA_DEV_BASE/ORCA_DEV_TOKEN are set at build time, an unconfigured extension
  // seeds this connection on first boot so automated MCP verification can run
  // without hand-driving the popup. Never set in a shipped build.
  define: {
    __ORCA_DEV_BASE__: JSON.stringify(process.env.ORCA_DEV_BASE || ''),
    __ORCA_DEV_TOKEN__: JSON.stringify(process.env.ORCA_DEV_TOKEN || ''),
  },
} satisfies BuildOptions;

await rm(dist('.'), { recursive: true, force: true });
await mkdir(dist('.'), { recursive: true });

await Promise.all([
  // Background service worker / event page: format 'esm' so it can `import`.
  build({ ...common, format: 'esm', entryPoints: [src('background.ts')], outfile: dist('background.js') }),
  // Popup script: classic bundle for the popup document.
  build({ ...common, format: 'iife', entryPoints: [src('popup/popup.ts')], outfile: dist('popup.js') }),
  // Content script: classic bundle injected into pages.
  build({ ...common, format: 'iife', entryPoints: [src('content/detect.ts')], outfile: dist('content.js') }),
  build({
    ...common,
    entryPoints: [src('content/inject.css')],
    outfile: dist('content.css'),
    loader: { '.css': 'css' },
  }),
]);

await cp(resolve(here, 'manifest.json'), dist('manifest.json'));
await cp(src('popup/popup.html'), dist('popup.html'));
await cp(src('popup/popup.css'), dist('popup.css'));
await cp(resolve(here, 'icons'), dist('icons'), { recursive: true });

console.log('dist-ext/ assembled (manifest, background.js, popup.*, content.*, icons/)');
