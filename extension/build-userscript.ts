// Assemble the headless Tampermonkey userscript into dist-ext/orca.user.js from
// the SAME sources as the extension (content/detect.ts + lib/*), plus the
// userscript-only runtime shim (src/userscript/*). One esbuild bundle, a
// userscript metadata banner, and the content CSS inlined via `define` so it
// ships as a single self-contained .user.js — no separate assets, nothing to
// maintain twice.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => resolve(here, 'src', p);
// Its own output dir (not dist-ext/, which the extension build wipes) so the two
// builds never clobber each other.
const out = resolve(here, 'dist-userscript', 'orca.user.js');

const manifest = JSON.parse(await readFile(resolve(here, 'manifest.json'), 'utf8')) as {
  version: string;
};
const css = await readFile(src('content/inject.css'), 'utf8');

// Orca logo, embedded as a data URI so Tampermonkey shows the project mark in its
// dashboard/menu WITHOUT a runtime fetch. A remote @icon URL would break whenever
// the self-hosted server is offline or on a different origin; inlining keeps the
// single .user.js self-contained. Source is the 192×192 master (not the 32px
// favicon) so it stays crisp when the manager downscales it to menu/dashboard
// sizes — sharp, not blurry, at a still-modest ~26 KB base64.
const iconPng = await readFile(resolve(here, 'icons', '192.png'));
const iconDataUri = `data:image/png;base64,${iconPng.toString('base64')}`;

// Userscript metadata block. `@match *://*/*` mirrors the extension's
// `<all_urls>`: the script must run on video sites (mount the button) AND on the
// Orca dashboard (bridge the token). `@connect` + GM_xmlhttpRequest lets the
// E2EE client reach the self-hosted server across origins.
//
// `@connect *` alone does NOT silently authorise loopback/IP hosts — Tampermonkey
// deliberately excludes localhost and raw IPs from the `*` wildcard, so a
// self-hosted Orca on 127.0.0.1 (the common dev/self-host case) still triggers the
// cross-origin confirmation dialog. Listing localhost + 127.0.0.1 explicitly kills
// that prompt for the loopback case. Tampermonkey has no CIDR/IP-wildcard, so a
// server on a LAN IP can't be pre-authorised here; for those `@connect *` still
// surfaces the dialog's one-click "Always allow all domains" button.
const banner = `// ==UserScript==
// @name         Orca Downloader
// @name:zh-CN   Orca 下载器
// @namespace    https://orca.app/
// @version      ${manifest.version}
// @description  Submit videos to your self-hosted Orca over its E2EE channel and download them straight from any video page. Headless twin of the Orca extension.
// @description:zh-CN 在任意视频页左上角注入下载/状态按钮，自动从 Orca 网页端读取并反向注入 token，通过 E2EE 通道提交到自建 Orca。
// @author       Orca
// @icon         ${iconDataUri}
// @icon64       ${iconDataUri}
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==
`;

await build({
  entryPoints: [src('userscript/main.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['firefox115', 'chrome110'],
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: banner },
  define: { __ORCA_CSS__: JSON.stringify(css) },
  outfile: out,
});

console.log('dist-userscript/orca.user.js assembled (single-file Tampermonkey userscript)');
