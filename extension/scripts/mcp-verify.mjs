/**
 * Automated Firefox acceptance check for the Orca extension.
 *
 * Drives the Mozilla `firefox-devtools-mcp` server over stdio (the same MCP an
 * agent uses interactively — see README "Install for testing") to:
 *   1. launch Firefox Developer Edition (headless) with a throwaway profile,
 *   2. temporarily load the built `dist-ext/` (no signing, no manual clicks),
 *   3. open a target page and confirm the content script + background boot
 *      cleanly (no extension-origin console errors),
 *   4. report whether the in-page `.orca-dl-btn` mounted, and save a screenshot.
 *
 * Run:  npm run build && npm run verify:ext
 *       ORCA_VERIFY_URL=https://www.youtube.com/watch?v=… npm run verify:ext
 *
 * Env overrides:
 *   ORCA_FIREFOX     path to a Firefox 153+ binary (auto-detected otherwise)
 *   ORCA_VERIFY_URL  page to open (default https://example.com/)
 *   MCP_SERVER_JS    path to firefox-devtools-mcp dist/index.js (else uses npx)
 *   HEADFUL=1        show the browser window
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist-ext');
const URL = process.env.ORCA_VERIFY_URL || 'https://example.com/';
const SHOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web-ext-artifacts', 'verify.png');

if (!existsSync(resolve(EXT, 'manifest.json'))) {
  console.error(`✗ ${EXT}/manifest.json missing — run \`npm run build\` first.`);
  process.exit(2);
}

function firefoxBinary() {
  if (process.env.ORCA_FIREFOX) return process.env.ORCA_FIREFOX;
  for (const p of ['/opt/firefox-devedition/firefox', '/usr/local/bin/firefox-devedition',
    '/usr/bin/firefox-devedition', '/usr/bin/firefox', '/usr/bin/librewolf']) {
    if (existsSync(p)) return p;
  }
  return '/usr/bin/firefox';
}

// Prefer a local/global firefox-devtools-mcp; fall back to npx.
function serverCmd() {
  if (process.env.MCP_SERVER_JS) return { cmd: 'node', pre: [process.env.MCP_SERVER_JS] };
  const guesses = [
    resolve(process.env.HOME || '', '.local/mcp/firefox-devtools/node_modules/@mozilla/firefox-devtools-mcp/dist/index.js'),
    resolve('node_modules/@mozilla/firefox-devtools-mcp/dist/index.js'),
  ];
  for (const g of guesses) if (existsSync(g)) return { cmd: 'node', pre: [g] };
  return { cmd: 'npx', pre: ['-y', '@mozilla/firefox-devtools-mcp@0.9.12'] };
}

const { cmd, pre } = serverCmd();
const args = [
  ...pre,
  `--firefoxPath=${firefoxBinary()}`,
  '--autoProfile', '--enableScript', '--viewport=1280x900',
  ...(process.env.HEADFUL ? [] : ['--headless']),
];

const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const pending = new Map(); let nextId = 1;
child.stdout.on('data', (d) => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  }
});
const rpc = (method, params) => { const id = nextId++; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 90000); }); };
const note = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const call = (name, a) => rpc('tools/call', { name, arguments: a });
const text = (r) => (r?.content || []).map((c) => c.text || '').join('\n');

function die(code, msg) { console.error(msg); child.kill(); process.exit(code); }

async function main() {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'orca-verify', version: '0' } });
  note('notifications/initialized', {});

  const inst = text(await call('install_extension', { type: 'path', path: EXT }));
  if (!/ID:\s*\S+/.test(inst)) die(1, `✗ extension failed to load:\n${inst}`);
  console.log(`✓ loaded temporary add-on: ${(inst.match(/ID:\s*(\S+)/) || [])[1]}`);

  await call('new_page', { url: URL });
  // Give the content script time to detect the page and mount.
  await new Promise((r) => setTimeout(r, 2500));

  const probe = JSON.parse(text(await call('evaluate_script', {
    function: '() => ({ title: document.title, btn: !!document.querySelector(".orca-dl-btn") })',
  })).replace(/^[^{]*/, '').replace(/```/g, '').trim() || '{}');
  console.log(`✓ page loaded: ${probe.title}`);
  console.log(probe.btn ? '✓ in-page .orca-dl-btn mounted' : 'ℹ no .orca-dl-btn on this page (expected on detected video pages)');

  const errs = text(await call('list_console_messages', { level: 'error', limit: 50 }));
  const extErr = errs.split('\n').filter((l) => /moz-extension|orca/i.test(l));
  if (extErr.length) die(1, `✗ extension console errors:\n${extErr.join('\n')}`);
  console.log('✓ no extension-origin console errors');

  try { await call('screenshot_page', { saveTo: SHOT }); console.log(`✓ screenshot → ${SHOT}`); } catch { /* optional */ }

  console.log('\nACCEPTANCE PASSED');
  child.kill(); process.exit(0);
}
main().catch((e) => die(1, `✗ ${e.message}`));
