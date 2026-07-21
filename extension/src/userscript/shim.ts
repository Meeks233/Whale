// Userscript runtime shim — the headless equivalent of the extension's
// background page. It recreates only the sliver of the WebExtension `browser`
// API that the content script (`../content/detect.ts`) actually talks to, backed
// by the SAME `OrcaClient` (→ `../lib/api.ts` → `../lib/e2ee.ts`) the extension
// background uses. So the download button, its state machine, the OSC v2 crypto
// and the whole API surface come from ONE shared source: maintain the extension
// and the userscript follows for free.
//
// There is no privileged background context here — everything runs in the page:
//   • Config (base + token) lives in the userscript manager's cross-origin GM
//     store, standing in for the extension's `browser.storage.local`.
//   • The token is read from — and mirrored back into — the Orca web app's own
//     `localStorage.orca_token` (see syncWebApp), so a user who is logged in to
//     the dashboard never types a token twice, and a cleared dashboard is
//     re-seeded from our cached copy.
//   • Cross-origin API calls are routed through `GM_xmlhttpRequest` (a real
//     Response shim), sidestepping CORS / Private-Network-Access entirely while
//     leaving `api.ts` / `e2ee.ts` calling plain `fetch()` unchanged.

import { OrcaClient } from '../lib/api.js';
import type { BgResponse, FeatureFlags, UserSiteAdapter } from '../lib/types.js';

// ---- Greasemonkey / Tampermonkey API (provided at runtime; declared here) ----
declare function GM_getValue<T>(key: string, def: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_addStyle(css: string): void;
declare function GM_xmlhttpRequest(details: GMXhrDetails): void;
declare function GM_registerMenuCommand(caption: string, onClick: () => void): void;
// The content CSS, inlined by the build (esbuild `define`) — mirrors how the
// background's build injects __ORCA_DEV_BASE__ etc. Never a runtime fetch.
declare const __ORCA_CSS__: string;

interface GMXhrResponse {
  status: number;
  responseHeaders: string;
  response: ArrayBuffer;
}
interface GMXhrDetails {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  responseType?: 'arraybuffer';
  onload?: (r: GMXhrResponse) => void;
  onerror?: (e: unknown) => void;
}

// ---- config (cross-origin GM store) ----

const CFG_KEY = 'orcaConfig';
const DEFAULT_FEATURES: FeatureFlags = {
  toolbarStatus: true,
  inpageButton: true,
  websiteManagement: true,
};

interface UsConfig {
  base: string;
  token: string;
  welcomeDone: boolean;
  siteAdapters: UserSiteAdapter[];
}

function loadCfg(): UsConfig {
  const raw = GM_getValue<Partial<UsConfig> | null>(CFG_KEY, null);
  return {
    base: (raw?.base ?? '').replace(/\/+$/, ''),
    token: raw?.token ?? '',
    welcomeDone: raw?.welcomeDone ?? false,
    siteAdapters: Array.isArray(raw?.siteAdapters) ? raw!.siteAdapters! : [],
  };
}

// Cache the base so the fetch shim doesn't hit the GM store on every page fetch.
let orcaBase = loadCfg().base;
// Merge a patch over the stored config so a credentials save never drops the
// user's imported site adapters (and vice-versa).
function saveCfg(patch: Partial<UsConfig>): void {
  const merged = { ...loadCfg(), ...patch };
  GM_setValue(CFG_KEY, merged);
  orcaBase = merged.base;
}

// ---- fetch shim: route Orca-base requests through GM_xmlhttpRequest ----
//
// The content script runs on youtube.com/x.com/… but the Orca server is a
// different (often LAN / localhost) origin. GM_xmlhttpRequest is the userscript
// escape hatch that a page `fetch` can't take. We only intercept requests aimed
// at the configured base; everything else hits the page's real fetch untouched.

const realFetch = globalThis.fetch.bind(globalThis);

function parseHeaders(raw: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of (raw || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) m.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return m;
}

function makeResponse(r: GMXhrResponse): Response {
  const headers = parseHeaders(r.responseHeaders);
  const buf = r.response;
  const shim = {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    text: async () => new TextDecoder().decode(buf),
    arrayBuffer: async () => buf,
    json: async () => JSON.parse(new TextDecoder().decode(buf)),
  };
  return shim as unknown as Response;
}

function gmFetch(url: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: (init?.method || 'GET').toUpperCase(),
      url,
      headers: (init?.headers as Record<string, string>) || {},
      data: init?.body as string | undefined,
      responseType: 'arraybuffer',
      onload: (r) => resolve(makeResponse(r)),
      onerror: () => reject(new Error('Orca request failed (network)')),
    });
  });
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (orcaBase && url.startsWith(orcaBase)) return gmFetch(url, init);
  return realFetch(input as RequestInfo | URL, init);
}) as typeof fetch;

// ---- OrcaClient (reused verbatim from the extension) ----

let client: OrcaClient | null = null;
function getClient(): OrcaClient {
  const cfg = loadCfg();
  if (!cfg.base || !cfg.token) throw new Error('not configured');
  if (!client || client.base !== cfg.base || client.token !== cfg.token) {
    client = new OrcaClient(cfg.base, cfg.token);
  }
  return client;
}

// ---- message handler: the subset of the background's `handle` detect.ts uses ----

async function handle(req: { type: string; [k: string]: unknown }): Promise<unknown> {
  switch (req.type) {
    case 'getConfig': {
      const cfg = loadCfg();
      // Only advertise "configured" once a token has been read from the web app;
      // otherwise detect.ts stays idle and mounts nothing.
      return {
        welcomeDone: cfg.welcomeDone && !!cfg.token,
        features: { ...DEFAULT_FEATURES },
        siteAdapters: cfg.siteAdapters,
      };
    }
    case 'setSiteAdapters': {
      saveCfg({ siteAdapters: (req.siteAdapters as UserSiteAdapter[]) ?? [] });
      return { siteAdapters: loadCfg().siteAdapters };
    }
    case 'submit':
      return getClient().submit(req.url as string); // { item, duplicate }
    case 'itemStatus':
      return { item: await getClient().getItem(req.slug as string) };
    case 'lookupItem':
      return { item: await getClient().lookupByUrl(req.url as string, (req.any as boolean) ?? false) };
    case 'lookupBatch':
      return { downloaded: [...(await getClient().lookupBatch(req.urls as string[]))] };
    case 'retryItem': {
      const c = getClient();
      await c.retryItem(req.slug as string);
      return { item: await c.getItem(req.slug as string) };
    }
    case 'cancelItem':
      return { data: await getClient().cancelItem(req.slug as string) };
    case 'openWebItem': {
      const base = loadCfg().base;
      if (!base) return { ok: true };
      // Reuse ONE Orca tab across clicks. `_blank` opened a fresh tab for every
      // video, piling them up. A NAMED target navigates the tab that is already
      // there (and focuses it); since only the `#orca-play=` hash differs, the web
      // app picks it up via its hashchange listener and swaps the player in place —
      // no reload, no flash. The app clears the hash after reading it, so replaying
      // the same video still registers as a change.
      const target = window.open(
        `${base}/#orca-play=${encodeURIComponent(req.slug as string)}`,
        'orca-web',
      );
      target?.focus();
      return { ok: true };
    }
    default:
      throw new Error('unknown request: ' + req.type);
  }
}

// ---- `browser` shim: detect.ts talks to this exactly as it does the background ----

const browserShim = {
  runtime: {
    sendMessage: (msg: unknown): Promise<BgResponse> =>
      handle(msg as { type: string }).then(
        (data) => ({ ok: true, data }) as BgResponse,
        (e: unknown) => {
          const err = e as Error & { status?: number };
          const resp: BgResponse = { ok: false, error: err.message || String(e) };
          if (err.status !== undefined) resp.status = err.status;
          return resp;
        },
      ),
    // No background → no SSE fan-out. detect.ts's own poll fallback (armPoll /
    // syncProgress) drives the ring, so this listener is intentionally inert.
    onMessage: { addListener: (_fn: unknown): void => {} },
    getURL: (path: string): string => path,
  },
};
(globalThis as unknown as { browser: unknown }).browser = browserShim;

// ---- token bridge: read from / reverse-inject into the Orca web app ----

// The dashboard is served from the Orca server root and marks itself with a
// static brand logo + PWA manifest. Recognise it structurally (no token needed)
// so we can sync credentials both ways on any page that IS the web app.
function isOrcaWebApp(): boolean {
  return (
    !!document.querySelector('link[rel="manifest"][href*="manifest.webmanifest"]') &&
    !!document.getElementById('brand-logo')
  );
}

function webBase(): string {
  return location.origin.replace(/\/+$/, '');
}

// READ half of the bridge: mirror the dashboard's live token (+ base) into the GM
// store so video pages on other origins can use it. Returns true if it wrote.
function mirrorTokenToGM(): boolean {
  const base = webBase();
  const webToken = localStorage.getItem('orca_token') || '';
  if (!webToken) return false;
  const cfg = loadCfg();
  if (cfg.token !== webToken || cfg.base !== base || !cfg.welcomeDone) {
    saveCfg({ base, token: webToken, welcomeDone: true });
    return true;
  }
  return false;
}

function syncWebApp(): void {
  if (!isOrcaWebApp()) return;
  const base = webBase();
  const webToken = localStorage.getItem('orca_token') || '';
  const cfg = loadCfg();
  if (webToken) {
    mirrorTokenToGM(); // READ: dashboard logged in → keep GM mirror fresh.
  } else if (cfg.token && cfg.base === base) {
    // REVERSE-INJECT: the dashboard lost its token (cleared storage) but we hold a
    // cached copy for THIS server — seed it back and reload once so the app boots
    // logged in. Guarded against a reload loop.
    if (!sessionStorage.getItem('orca_us_seeded')) {
      localStorage.setItem('orca_token', cfg.token);
      localStorage.setItem('orca_welcome_done', '1');
      sessionStorage.setItem('orca_us_seeded', '1');
      location.reload();
    }
  }
  installLiveTokenSync(); // keep GM in lock-step with later token changes (B).
}

// Pick up a token the user changes on the dashboard AFTER first load — e.g. via
// the Settings / welcome token field — without waiting for a page reload. The
// `storage` event covers OTHER tabs of this origin but never fires in the tab
// that made the change, so a light poll (dashboard pages only) closes that gap.
let liveSyncInstalled = false;
function installLiveTokenSync(): void {
  if (liveSyncInstalled) return;
  liveSyncInstalled = true;
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === 'orca_token' || e.key === null) mirrorTokenToGM();
  });
  let last = localStorage.getItem('orca_token') || '';
  setInterval(() => {
    const now = localStorage.getItem('orca_token') || '';
    if (now !== last) {
      last = now;
      if (now) mirrorTokenToGM();
    }
  }, 2000);
}

// ---- manual config fallback: userscript-manager menu commands ----
//
// The bridge above is zero-config for anyone who uses the web app, but leaves a
// gap: a user who has never opened the dashboard has no way in, and a stale token
// has no reset. These menu entries cover both, and double as a debugging surface.

function maskToken(t: string): string {
  if (!t) return '(none)';
  return t.length <= 6 ? '••••' : `${t.slice(0, 3)}…${t.slice(-2)}`;
}

function registerMenu(): void {
  if (typeof GM_registerMenuCommand !== 'function') return;
  GM_registerMenuCommand('Orca: set server + token', () => {
    const cfg = loadCfg();
    const base = window.prompt('Orca server base URL (e.g. https://orca.example.com):', cfg.base);
    if (base == null) return;
    const token = window.prompt('Orca API token:', cfg.token);
    if (token == null) return;
    const cleanBase = base.trim().replace(/\/+$/, '');
    const cleanToken = token.trim();
    saveCfg({ base: cleanBase, token: cleanToken, welcomeDone: !!(cleanBase && cleanToken) });
    client = null; // force a fresh handshake with the new credentials
    if (!cleanBase || !cleanToken) {
      window.alert('Orca: config cleared (base or token empty).');
      return;
    }
    void new OrcaClient(cleanBase, cleanToken).validate().then(
      (r) => window.alert(r === '' ? 'Orca: connected ✓' : `Orca: saved, but validation failed (${r}).`),
      () => window.alert('Orca: saved, but could not reach the server.'),
    );
  });
  GM_registerMenuCommand('Orca: show current config', () => {
    const cfg = loadCfg();
    window.alert(
      `Orca config\nbase: ${cfg.base || '(none)'}\ntoken: ${maskToken(cfg.token)}\nconfigured: ${cfg.welcomeDone}`,
    );
  });
  GM_registerMenuCommand('Orca: clear config', () => {
    if (!window.confirm('Clear the stored Orca server + token?')) return;
    saveCfg({ base: '', token: '', welcomeDone: false });
    client = null;
    window.alert('Orca: config cleared.');
  });
  // Import custom site adapters (for platforms the built-ins don't cover) as a
  // JSON array. Kept as a menu action so the headless userscript needs no UI. The
  // content script re-reads these within ~15s, so a new platform lights up without
  // a reload. See content/sites.ts for the adapter shape.
  GM_registerMenuCommand('Orca: import site adapters (JSON)', () => {
    const cfg = loadCfg();
    const example =
      '[{"id":"bilibili","hosts":["bilibili.com"],' +
      '"thumbSelector":"a:has(img)","pathRegex":"/video/(BV[\\\\w]+)",' +
      '"canonical":"https://www.bilibili.com/video/{id}"}]';
    const input = window.prompt(
      'Paste a JSON array of site adapters (empty array to clear):',
      cfg.siteAdapters.length ? JSON.stringify(cfg.siteAdapters) : example,
    );
    if (input == null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      window.alert('Orca: not valid JSON.');
      return;
    }
    if (!Array.isArray(parsed)) {
      window.alert('Orca: expected a JSON array of adapters.');
      return;
    }
    saveCfg({ siteAdapters: parsed as UserSiteAdapter[] });
    window.alert(`Orca: saved ${parsed.length} site adapter(s).`);
  });
}

// ---- boot (runs before detect.ts's module body — see ./main.ts import order) ----

GM_addStyle(__ORCA_CSS__);
registerMenu(); // A: manual config fallback, available on every page
syncWebApp(); // token bridge + live sync (B), dashboard pages only
