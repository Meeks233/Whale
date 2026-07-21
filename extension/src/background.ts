// Background context: owns the single OSC session, the SSE progress stream, the
// persisted config, and the toolbar-icon state machine. Content scripts and the
// popup talk to it over runtime messaging; it never exposes the token or session
// key to page contexts.

import { OrcaClient, type EventsHandle } from './lib/api.js';
import { drawGlyph, drawRing, type GlyphName } from './lib/glyphs.js';
import { ringPercentForPhase } from './lib/progress.js';
import type {
  BgRequest,
  BgResponse,
  FeatureFlags,
  ProgressEvent,
  StoredConfig,
  Status,
} from './lib/types.js';

// Injected by esbuild `define` (build.ts). Empty strings in a shipped build.
declare const __ORCA_DEV_BASE__: string;
declare const __ORCA_DEV_TOKEN__: string;

const DEFAULT_FEATURES: FeatureFlags = {
  toolbarStatus: true,
  inpageButton: true,
  websiteManagement: true,
};

const COLORS = {
  idle: '#7c5cff',
  ring: '#7c5cff',
  track: 'rgba(140,140,160,0.35)',
  spin: '#7c5cff',
  ok: '#2ea043',
  err: '#e5534b',
};

let config: StoredConfig | null = null;
let client: OrcaClient | null = null;
let events: EventsHandle | null = null;
let eventsReconnect: ReturnType<typeof setTimeout> | null = null;

// Hold the toolbar ring just under full while running: a full ring is reserved
// for a real completion. yt-dlp reports per-stream percent (video 0→100 then
// audio 0→100), so an un-capped ring would read "done" at the end of the video
// stream mid-download. Mirrors the in-page button's RUNNING_RING_MAX.
const RUNNING_RING_MAX = 95;

// One active download drives the toolbar icon. Item id -> originating tab (for
// in-page button fan-out) and slug (for deep-linking to the web player).
interface Watch {
  slug: string;
  tabId?: number;
  status: Status;
  percent: number | null;
  // Furthest-forward capped percent shown on the ring, so the toolbar only ever
  // advances and never snaps backwards between the video and audio streams.
  shown: number;
  // Whether a `video` phase frame has been seen, so a later `audio` frame maps as
  // the tail of a two-stream job rather than an audio-only download (see applyStatus).
  sawVideo?: boolean;
}
const watches = new Map<number, Watch>();
let toolbarItem: number | null = null;
// Poll fallback for the toolbar's active download. The SSE stream is the fast
// path, but a cancel/pause (or a delete) triggered from ANOTHER client emits no
// terminal frame the background will see, so the ring would otherwise freeze at
// its last percent. This poll re-reads the item whenever pushes go quiet and
// settles the toolbar into the item's true end state. Re-armed by every push.
let toolbarPoll: ReturnType<typeof setTimeout> | null = null;

// ---- config ----

async function loadConfig(): Promise<StoredConfig> {
  if (config) return config;
  const raw = (await browser.storage.local.get('orcaConfig')) as { orcaConfig?: StoredConfig };
  config = {
    base: raw.orcaConfig?.base ?? '',
    token: raw.orcaConfig?.token ?? '',
    welcomeDone: raw.orcaConfig?.welcomeDone ?? false,
    features: { ...DEFAULT_FEATURES, ...(raw.orcaConfig?.features ?? {}) },
  };
  // Dev-only auto-config seed (see build.ts define). Both constants are "" in a
  // shipped build, so this whole block compiles to a dead no-op there.
  if (!config.token && __ORCA_DEV_BASE__ && __ORCA_DEV_TOKEN__) {
    config.base = __ORCA_DEV_BASE__.replace(/\/+$/, '');
    config.token = __ORCA_DEV_TOKEN__;
    config.welcomeDone = true;
    await saveConfig();
  }
  return config;
}

async function saveConfig(): Promise<void> {
  if (config) await browser.storage.local.set({ orcaConfig: config });
}

function getClient(): OrcaClient {
  const cfg = config;
  if (!cfg || !cfg.base || !cfg.token) throw new Error('not configured');
  if (!client || client.base !== cfg.base.replace(/\/+$/, '') || client.token !== cfg.token) {
    client = new OrcaClient(cfg.base, cfg.token);
  }
  return client;
}

// ---- toolbar icon state machine ----

const SIZES = [16, 32] as const;
const canvases = new Map<number, OffscreenCanvas>();
let spinTimer: ReturnType<typeof setInterval> | null = null;
let spinAngle = 0;
// What the shared spin timer is currently animating, so a running spin of the
// wrong kind (loader glyph vs finalizing ring) is swapped rather than left as-is.
let spinKind: 'loader' | 'ring' | null = null;

// The idle toolbar shows the project's own logo (not a download glyph); a small
// solid dot in its top-right corner reflects whether the remote is reachable
// (green) or unreachable (red). Unknown => no dot. Steady, not breathing — it
// mirrors the web home page's solid status light.
// The source art is a solid orca silhouette on transparency. We DON'T paint a
// coloured tile behind it — just the bare monochrome mark, recoloured to read on
// whatever the toolbar is: white on a dark toolbar, near-black on a light one.
// The toolbar's own colour (from the active Firefox theme) picks which. Both
// recoloured silhouettes are built once.
let logoBitmap: ImageBitmap | null = null;
let logoWhite: ImageBitmap | null = null;
let logoDark: ImageBitmap | null = null;
let remoteOnline: boolean | null = null;
let remotePollTimer: ReturnType<typeof setInterval> | null = null;
// Whether the browser toolbar is dark (so the mark is drawn white) or light (so
// it's drawn near-black). Defaults to dark — the common Firefox toolbar.
let toolbarDark = true;

// Recolour the silhouette to a solid `color`, preserving its alpha shape.
async function recolour(src: ImageBitmap, color: string): Promise<ImageBitmap> {
  const oc = new OffscreenCanvas(src.width, src.height);
  const c = oc.getContext('2d') as OffscreenCanvasRenderingContext2D;
  c.drawImage(src, 0, 0);
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = color;
  c.fillRect(0, 0, oc.width, oc.height);
  return createImageBitmap(oc);
}

// Crop the source art down to its opaque bounds. The logo.png carries a chunk of
// transparent margin; drawn as-is the mark reads noticeably smaller than other
// toolbar icons (which fill their box). Trimming it lets drawLogoMark scale the
// silhouette to fill the icon.
async function cropToContent(bmp: ImageBitmap): Promise<ImageBitmap> {
  const oc = new OffscreenCanvas(bmp.width, bmp.height);
  const c = oc.getContext('2d') as OffscreenCanvasRenderingContext2D;
  c.drawImage(bmp, 0, 0);
  const { data, width, height } = c.getImageData(0, 0, bmp.width, bmp.height);
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3]! > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < minX || maxY < minY) return bmp; // fully transparent — leave as-is
  return createImageBitmap(bmp, minX, minY, maxX - minX + 1, maxY - minY + 1);
}

async function ensureLogo(): Promise<ImageBitmap | null> {
  if (logoBitmap) return logoBitmap;
  try {
    const url = browser.runtime.getURL('icons/logo.png');
    const blob = await (await fetch(url)).blob();
    logoBitmap = await cropToContent(await createImageBitmap(blob));
    logoWhite = await recolour(logoBitmap, '#ffffff');
    logoDark = await recolour(logoBitmap, '#1a1a22');
  } catch {
    logoBitmap = null;
  }
  return logoBitmap;
}

// Relative luminance of a theme colour (accepts "#rrggbb", "rgb(...)", or an
// [r,g,b(,a)] array as Firefox themes may hand back). Null when unparseable.
function colourLuminance(c: unknown): number | null {
  let r: number, g: number, b: number;
  if (Array.isArray(c) && c.length >= 3) {
    [r, g, b] = c as number[];
  } else if (typeof c === 'string') {
    const hex = c.trim().match(/^#?([0-9a-f]{6})$/i);
    const rgb = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (hex) {
      const n = parseInt(hex[1]!, 16);
      r = (n >> 16) & 255;
      g = (n >> 8) & 255;
      b = n & 255;
    } else if (rgb) {
      r = +rgb[1]!;
      g = +rgb[2]!;
      b = +rgb[3]!;
    } else {
      return null;
    }
  } else {
    return null;
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Read the active Firefox theme and decide whether the toolbar is dark. No
// permission is needed to *read* the theme; failures just keep the last guess.
async function detectToolbarTheme(): Promise<void> {
  try {
    const theme = (await browser.theme.getCurrent()) as { colors?: Record<string, unknown> };
    const colors = theme?.colors;
    if (!colors) return; // no custom theme => default; keep the standing guess
    const lum =
      colourLuminance(colors.toolbar) ??
      colourLuminance(colors.frame) ??
      colourLuminance(colors.toolbar_field) ??
      colourLuminance(colors.popup);
    if (lum != null) toolbarDark = lum < 0.5;
  } catch {
    /* theme API unavailable — keep the standing guess */
  }
}

// The bare monochrome orca mark — no tile, coloured to contrast the toolbar, and
// scaled to fill the icon box (aspect-preserving, centred) so it reads at the
// same weight as other toolbar icons. Falls back to the stroked cloud glyph
// until the bitmap has loaded.
function drawLogoMark(ctx: OffscreenCanvasRenderingContext2D, size: number): void {
  const mark = toolbarDark ? logoWhite : logoDark;
  if (mark) {
    const inset = Math.max(0.5, size * 0.03);
    const box = size - inset * 2;
    const scale = Math.min(box / mark.width, box / mark.height);
    const w = mark.width * scale;
    const h = mark.height * scale;
    ctx.drawImage(mark, (size - w) / 2, (size - h) / 2, w, h);
  } else {
    drawGlyph(ctx, 'cloudDownload', size, toolbarDark ? '#fff' : '#1a1a22');
  }
}

// A small solid status dot in the icon's top-right corner, with a soft dark halo
// so it reads on any logo. Steady (no pulse) — it mirrors the web home page's
// solid status light.
function drawStatusDot(
  ctx: OffscreenCanvasRenderingContext2D,
  size: number,
  color: string,
): void {
  const r = Math.max(2.2, size * 0.2);
  const cx = size - r - Math.max(0.5, size * 0.03);
  const cy = r + Math.max(0.5, size * 0.03);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r + Math.max(1, size * 0.06), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10,10,14,0.55)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function paintIdle(): void {
  const online = remoteOnline;
  const dotColor = online ? COLORS.ok : COLORS.err;
  void ensureLogo().then(() =>
    setActionIcon((ctx, size) => {
      drawLogoMark(ctx, size);
      if (online !== null) drawStatusDot(ctx, size, dotColor);
    }),
  );
}

function ctxFor(size: number): OffscreenCanvasRenderingContext2D {
  let c = canvases.get(size);
  if (!c) {
    c = new OffscreenCanvas(size, size);
    canvases.set(size, c);
  }
  return c.getContext('2d') as OffscreenCanvasRenderingContext2D;
}

async function setActionIcon(
  paint: (ctx: OffscreenCanvasRenderingContext2D, size: number) => void,
): Promise<void> {
  const imageData: Record<number, ImageData> = {};
  for (const size of SIZES) {
    const ctx = ctxFor(size);
    ctx.clearRect(0, 0, size, size);
    paint(ctx, size);
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  try {
    await browser.action.setIcon({ imageData });
  } catch {
    /* action API may be briefly unavailable during startup */
  }
}

function stopSpin(): void {
  if (spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
  }
  spinKind = null;
}

function badge(text: string, color: string): void {
  void browser.action.setBadgeText({ text });
  if (text) void browser.action.setBadgeBackgroundColor({ color });
}

function paintGlyph(name: GlyphName, color: string): void {
  void setActionIcon((ctx, size) => drawGlyph(ctx, name, size, color));
}

function renderToolbar(): void {
  if (!config?.features.toolbarStatus) {
    stopSpin();
    paintIdle();
    badge('', COLORS.idle);
    return;
  }
  const w = toolbarItem != null ? watches.get(toolbarItem) : undefined;
  if (!w) {
    // No active download: project logo + solid remote-status dot.
    stopSpin();
    paintIdle();
    badge('', COLORS.idle);
    return;
  }
  // An active download owns the icon.
  if (w.status === 'completed' || w.status === 'duplicate') {
    stopSpin();
    paintGlyph('cloudCheck', COLORS.ok);
    badge('', COLORS.ok);
    return;
  }
  if (w.status === 'failed' || w.status === 'canceled') {
    stopSpin();
    paintGlyph('x', COLORS.err);
    badge('!', COLORS.err);
    return;
  }
  // queued / running / paused
  if (w.percent != null && w.status === 'running') {
    const frac = w.shown / 100;
    // At the running cap the transfer is done and yt-dlp is silently post-
    // processing (merge + embed) — no more frames move the ring. Spin the near-
    // full ring so it reads as "finalizing" instead of freezing at 95%.
    if (w.shown >= RUNNING_RING_MAX) {
      if (spinKind !== 'ring') {
        stopSpin();
        spinKind = 'ring';
        spinTimer = setInterval(() => {
          spinAngle = (spinAngle + Math.PI / 12) % (Math.PI * 2);
          void setActionIcon((ctx, size) =>
            drawRing(ctx, size, frac, COLORS.ring, COLORS.track, spinAngle),
          );
        }, 90);
      }
    } else {
      stopSpin();
      void setActionIcon((ctx, size) => drawRing(ctx, size, frac, COLORS.ring, COLORS.track));
    }
    badge(`${Math.round(w.shown)}`, COLORS.ring);
    return;
  }
  // No percent yet: spin the loader glyph.
  badge('', COLORS.spin);
  if (spinKind !== 'loader') {
    stopSpin();
    spinKind = 'loader';
    spinTimer = setInterval(() => {
      spinAngle = (spinAngle + Math.PI / 6) % (Math.PI * 2);
      void setActionIcon((ctx, size) => drawGlyph(ctx, 'loader', size, COLORS.spin, spinAngle));
    }, 90);
  }
}

// ---- remote reachability (drives the idle icon's breathing status dot) ----

function setRemoteOnline(online: boolean | null): void {
  if (remoteOnline === online) return;
  remoteOnline = online;
  // Only the idle icon reflects reachability; an active download owns the icon.
  if (toolbarItem == null || !watches.get(toolbarItem)) renderToolbar();
}

async function pingRemote(): Promise<void> {
  if (!config?.base || !config?.token) {
    setRemoteOnline(null);
    return;
  }
  try {
    const result = await getClient().validate();
    setRemoteOnline(result === '');
  } catch {
    setRemoteOnline(false);
  }
}

function startRemotePolling(): void {
  if (remotePollTimer) return;
  void pingRemote();
  remotePollTimer = setInterval(() => void pingRemote(), 30000);
}

// ---- SSE ----

async function ensureEvents(): Promise<void> {
  if (events || !config?.token || !config?.base) return;
  try {
    events = await getClient().openEvents(onProgress, onEventsError);
  } catch (e) {
    onEventsError(e);
  }
}

function onEventsError(_e: unknown): void {
  if (events) {
    events.close();
    events = null;
  }
  if (eventsReconnect) clearTimeout(eventsReconnect);
  if (watches.size > 0) {
    eventsReconnect = setTimeout(() => void ensureEvents(), 3000);
  }
}

const isTerminal = (s: Status): boolean =>
  s === 'completed' || s === 'failed' || s === 'canceled' || s === 'duplicate';

function onProgress(ev: ProgressEvent): void {
  const w = watches.get(ev.id);
  if (!w) return;
  applyStatus(w, ev.id, ev.status, ev.percent, ev.phase);
  if (w.tabId != null) {
    browser.tabs.sendMessage(w.tabId, { type: 'progress', event: ev }).catch(() => {
      /* tab gone */
    });
  }
}

// Fold a status/percent update (from an SSE push OR the poll fallback) into a
// watch, keep the toolbar ring monotonic, and drive the toolbar + the terminal
// hand-off. Shared so a cancel the poll discovers settles exactly like a pushed
// completion would.
function applyStatus(
  w: Watch,
  id: number,
  status: Status,
  percent: number | null,
  phase?: string | null,
): void {
  w.status = status;
  if (percent != null) w.percent = percent;
  if (status === 'running' && percent != null) {
    // Map per-stream percent onto contiguous phase bands so the ring keeps
    // advancing through the audio pass instead of freezing at the cap once the
    // video stream hits 100% (see lib/progress.ts). Still only ever advances.
    if (phase === 'video') w.sawVideo = true;
    w.shown = Math.max(w.shown, ringPercentForPhase(percent, phase, w.sawVideo ?? false, RUNNING_RING_MAX));
  }
  const isToolbar = toolbarItem === id;
  if (isToolbar) renderToolbar();
  if (isTerminal(status)) {
    if (isToolbar) stopToolbarPoll();
    // Briefly hold the final state, then fall back to the idle logo + solid
    // status light so the toolbar doesn't linger on a stale download.
    setTimeout(() => {
      watches.delete(id);
      if (toolbarItem === id) {
        toolbarItem = null;
        renderToolbar();
      }
    }, 5000);
  } else if (isToolbar) {
    armToolbarPoll();
  }
}

function stopToolbarPoll(): void {
  if (toolbarPoll) {
    clearTimeout(toolbarPoll);
    toolbarPoll = null;
  }
}

// The watched download is over and there's no terminal state to hold (it was
// deleted): drop it and fall the toolbar back to the idle logo immediately.
function clearToolbarWatch(id: number): void {
  stopToolbarPoll();
  watches.delete(id);
  if (toolbarItem === id) {
    toolbarItem = null;
    renderToolbar();
  }
}

function armToolbarPoll(): void {
  stopToolbarPoll();
  toolbarPoll = setTimeout(() => void pollToolbar(), 3000);
}

// Re-read the toolbar's active item when SSE pushes go quiet. Catches a terminal
// state no push delivered — above all a cancel/pause fired from another client,
// which is exactly what left the ring frozen at its last percent.
async function pollToolbar(): Promise<void> {
  toolbarPoll = null;
  const id = toolbarItem;
  if (id == null) return;
  const w = watches.get(id);
  if (!w || isTerminal(w.status)) return;
  try {
    const item = await getClient().getItem(w.slug);
    const prog = (item as { progress?: { percent: number | null; phase?: string | null } }).progress;
    applyStatus(w, id, item.status, prog?.percent ?? null, prog?.phase);
  } catch (e) {
    // 404 → the item was deleted (a delete of an in-flight download is exactly
    // what froze the ring): the download is over, so clear the toolbar instead of
    // polling a gone item forever. Any other error (server unreachable) → keep
    // watching; the ring holds until it answers.
    if ((e as { status?: number }).status === 404) {
      clearToolbarWatch(id);
    } else if (toolbarItem === id) {
      armToolbarPoll();
    }
  }
}

// ---- cookie extraction ----

// Registrable domain, best-effort (last two labels). Good enough for the
// single-label TLDs we target; a public-suffix list would be overkill here.
function registrableDomain(host: string): string {
  const h = host.replace(/^www\./, '');
  const parts = h.split('.');
  return parts.length <= 2 ? h : parts.slice(-2).join('.');
}

// Netscape cookies.txt — the format yt-dlp wants, and (unlike document.cookie)
// this includes HttpOnly auth cookies, which are the whole point of extracting.
function toNetscape(cookies: browser.cookies.Cookie[]): string {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expiry = c.session || c.expirationDate == null ? 0 : Math.floor(c.expirationDate);
    lines.push(
      [c.domain, includeSub, c.path, c.secure ? 'TRUE' : 'FALSE', String(expiry), c.name, c.value].join(
        '\t',
      ),
    );
  }
  return lines.join('\n') + '\n';
}

// One-click: pull the current page's cookies (HttpOnly included), file them
// under the website that already covers this domain — creating one only if none
// does, so we never spawn duplicate site entries.
async function extractCookies(
  pageUrl: string,
): Promise<{ key: string; name: string; count: number; created: boolean }> {
  const c = getClient();
  const host = new URL(pageUrl).hostname;
  const reg = registrableDomain(host);

  const collected = new Map<string, browser.cookies.Cookie>();
  for (const domain of new Set([host, reg])) {
    const got = await browser.cookies.getAll({ domain });
    for (const ck of got) collected.set(`${ck.domain}\t${ck.path}\t${ck.name}`, ck);
  }
  const cookies = [...collected.values()];
  if (cookies.length === 0) throw new Error('No cookies found for this page.');

  const sites = await c.listWebsites();
  const match = sites.find((s) =>
    s.hosts.some((h) => {
      const b = h.replace(/^\./, '');
      return host === b || host.endsWith('.' + b) || reg === b;
    }),
  );

  let key = match?.key;
  let created = false;
  if (!key) {
    const base = reg.split('.')[0]!.replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'site';
    key = sites.some((s) => s.key === base) ? reg.replace(/[^a-z0-9_]/gi, '_').toLowerCase() : base;
    await c.upsertWebsite(key, { name: reg, hosts: reg, enabled: true });
    created = true;
  }
  await c.setCookies(key, toNetscape(cookies));
  return { key, name: match?.name ?? reg, count: cookies.length, created };
}

// ---- dashboard auto-login ----

// Resolve once a tab has finished loading (or after a timeout, so we never hang).
function waitForTabComplete(tabId: number, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: browser.tabs._OnUpdatedChangeInfo): void => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    browser.tabs.onUpdated.addListener(listener);
    // It may already be complete before the listener attached.
    void browser.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') finish();
    });
  });
}

// Log the dashboard in WITHOUT ever putting the token in its URL. The web app
// keeps the token in localStorage per origin, so a set-up dashboard stays logged
// in on its own across opens. We write the token straight into that origin's
// storage — never the address bar/history — and only when it's genuinely missing,
// then reload so the app boots configured. The token is written directly into the
// page's storage; it never travels over a URL, so it can't leak into history.
async function seedDashboardToken(tabId: number, token: string): Promise<void> {
  await waitForTabComplete(tabId);
  // Runs in the page context (serialized, so it can't close over anything here).
  const probe = (tok: string): 'present' | 'seeded' => {
    if (localStorage.getItem('orca_token')) return 'present';
    localStorage.setItem('orca_token', tok);
    localStorage.setItem('orca_welcome_done', '1');
    return 'seeded';
  };
  const results = await browser.scripting.executeScript({
    target: { tabId },
    // The injected func is typed void by the API; it does return a value.
    func: probe as (tok: string) => void,
    args: [token],
  });
  // Reload only when we just planted the token, so the app boots configured; if it
  // was already present the existing session stands (and any deep-link hash holds).
  if ((results?.[0]?.result as unknown) === 'seeded') await browser.tabs.reload(tabId);
}

// Open the web app at its own origin (optionally at a deep-link hash) and seed the
// token into that origin's storage so it boots logged in. If a tab is already on
// the web app's origin, reuse it — focus that tab/window rather than piling up a
// fresh one.
async function openWeb(hash: string): Promise<void> {
  if (!config?.base) throw new Error('Not connected.');
  const base = config.base.replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const existing = (await browser.tabs.query({})).find((t) => {
    if (!t.url) return false;
    try {
      return new URL(t.url).origin === origin;
    } catch {
      return false;
    }
  });
  if (existing?.id != null) {
    await browser.tabs.update(existing.id, { active: true });
    if (existing.windowId != null)
      await browser.windows.update(existing.windowId, { focused: true });
    // Deep-link WITHOUT reloading the tab (a full reload flashes the whole app and
    // jars the eye). The web app now listens for `hashchange`, so we set the
    // `#orca-play=` hash from inside the page and the SPA opens the player in
    // place — no reflow, no flash. (No hash = plain dashboard open: just focus.)
    if (hash) {
      await browser.scripting.executeScript({
        target: { tabId: existing.id },
        func: (h: string) => {
          // Force a hashchange even if the hash is unchanged from a prior play.
          if (location.hash === h) location.hash = '';
          location.hash = h;
        },
        args: [hash],
      });
    }
    if (config.token) void seedDashboardToken(existing.id, config.token);
    return;
  }
  const tab = await browser.tabs.create({ url: base + hash });
  if (config.token && tab.id != null) void seedDashboardToken(tab.id, config.token);
}

// ---- request handling ----

async function handle(req: BgRequest, sender: browser.runtime.MessageSender): Promise<unknown> {
  const cfg = await loadConfig();
  switch (req.type) {
    case 'getConfig':
      return { base: cfg.base, welcomeDone: cfg.welcomeDone, features: cfg.features, hasToken: !!cfg.token };

    case 'setConnection': {
      cfg.base = req.base.replace(/\/+$/, '');
      cfg.token = req.token;
      cfg.welcomeDone = true;
      client = null;
      await saveConfig();
      if (events) {
        events.close();
        events = null;
      }
      void pingRemote();
      return { ok: true };
    }

    case 'validate': {
      const probe = new OrcaClient(req.base, req.token);
      return { result: await probe.validate() };
    }

    case 'setFeatures': {
      cfg.features = { ...cfg.features, ...req.features };
      await saveConfig();
      renderToolbar();
      return { features: cfg.features };
    }

    case 'submit': {
      const c = getClient();
      const result = await c.submit(req.url);
      const item = result.item;
      const watch: Watch = { slug: item.slug, status: item.status, percent: null, shown: 0 };
      if (req.tabWatch && sender.tab?.id != null) watch.tabId = sender.tab.id;
      watches.set(item.id, watch);
      toolbarItem = item.id;
      renderToolbar();
      // Guard against a download that ends without ever pushing a terminal frame
      // (e.g. cancelled from another client) leaving the ring stuck.
      if (!isTerminal(item.status)) armToolbarPoll();
      await ensureEvents();
      return { item, duplicate: result.duplicate };
    }

    case 'itemStatus': {
      const item = await getClient().getItem(req.slug);
      return { item };
    }

    case 'cancelItem':
      return { data: await getClient().cancelItem(req.slug) };

    case 'retryItem': {
      // Re-queue, then set up the same toolbar/tab watch a fresh submit does, so
      // the retried download drives the toolbar ring and (for the overlay button)
      // gets live SSE progress pushes — not just the button's own poll fallback.
      const c = getClient();
      await c.retryItem(req.slug);
      const item = await c.getItem(req.slug);
      const watch: Watch = { slug: item.slug, status: item.status, percent: null, shown: 0 };
      if (req.tabWatch && sender.tab?.id != null) watch.tabId = sender.tab.id;
      watches.set(item.id, watch);
      toolbarItem = item.id;
      renderToolbar();
      if (!isTerminal(item.status)) armToolbarPoll();
      await ensureEvents();
      return { item };
    }

    case 'deleteItem':
      return { data: await getClient().deleteItem(req.slug) };

    case 'lookupItem': {
      const item = await getClient().lookupByUrl(req.url, req.any ?? false);
      return { item };
    }

    case 'listItems':
      return { items: await getClient().listItems(req.limit ?? 20) };

    case 'thumb':
      return { dataUrl: await getClient().fetchThumb(req.slug) };

    case 'extractCookies':
      return extractCookies(req.url);

    case 'listWebsites':
      return { websites: await getClient().listWebsites() };

    case 'upsertWebsite':
      return { data: await getClient().upsertWebsite(req.key, req.body) };

    case 'deleteWebsite':
      return { data: await getClient().deleteWebsite(req.key) };

    case 'setCookies':
      return { data: await getClient().setCookies(req.key, req.cookies) };

    case 'toggleCookies':
      return { data: await getClient().toggleCookies(req.key, req.enabled) };

    case 'deleteCookies':
      return { data: await getClient().deleteCookies(req.key) };

    case 'openDashboard':
      await openWeb('');
      return { ok: true };

    case 'openWebItem':
      // Play a finished download in the web app itself (its own origin, where the
      // media service worker and the real player live — which prefers the copy the
      // server already has on disk over re-resolving the upstream CDN). We hand it
      // only the item's public slug via a `#orca-play=` hash (an identifier, not a
      // secret); the token is seeded into storage separately, never the URL.
      await openWeb(`#orca-play=${encodeURIComponent(req.slug)}`);
      return { ok: true };

    default:
      throw new Error('unknown request');
  }
}

browser.runtime.onMessage.addListener((message, sender): Promise<BgResponse> => {
  return handle(message as BgRequest, sender).then(
    (data) => ({ ok: true, data }) as BgResponse,
    (e: unknown) => {
      const err = e as Error & { status?: number };
      const resp: BgResponse = { ok: false, error: err.message || String(e) };
      if (err.status !== undefined) resp.status = err.status;
      return resp;
    },
  );
});

// Repaint the idle mark when the browser theme flips (light <-> dark toolbar) so
// the monochrome logo always contrasts. No permission needed to observe this.
try {
  browser.theme.onUpdated.addListener(() => {
    void detectToolbarTheme().then(() => {
      if (toolbarItem == null || !watches.get(toolbarItem)) renderToolbar();
    });
  });
} catch {
  /* theme API unavailable */
}

// Paint the idle icon as soon as the worker wakes, then start watching the
// remote so the status dot reflects reachability.
void Promise.all([loadConfig(), detectToolbarTheme()]).then(() => {
  renderToolbar();
  startRemotePolling();
});
