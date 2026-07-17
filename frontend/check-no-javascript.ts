// Hand-written frontend tooling and application code must be strict TypeScript.
// Browsers still require JavaScript, so only these generated bundles are allowed.
import { readdir } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const javascriptExtensions = new Set(['.js', '.mjs', '.cjs', '.jsx']);
const allowedGenerated = new Set(['web/app.js', 'web/theme.js', 'web/sw.js']);
// Snippets injected verbatim into a page that the app does not build or ship:
// chrome-devtools evaluates an `initScript` as raw source in the browser, so
// there is no compile step this could hang a TypeScript build off of.
const allowedInjected = new Set(['packaging/screenshots/demo-data.js']);
const ignoredDirectories = new Set([
  '.git',
  '.claude',
  '.opencode',
  'node_modules',
  'target',
  'data',
  'downloads',
  'scripts',
]);
const violations: string[] = [];

async function scan(directory: string): Promise<void> {
  // The recursion starts at this repository root and never follows symlinks.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(absolute);
      continue;
    }
    if (!entry.isFile() || !javascriptExtensions.has(extname(entry.name).toLowerCase())) continue;
    const projectPath = relative(root, absolute).split(sep).join('/');
    if (!allowedGenerated.has(projectPath) && !allowedInjected.has(projectPath)) {
      violations.push(projectPath);
    }
  }
}

await scan(root);
if (violations.length > 0) {
  throw new Error(`Hand-written JavaScript is forbidden; migrate to strict TypeScript:\n${violations.join('\n')}`);
}

console.log('JavaScript source check passed; only generated web bundles are present.');
