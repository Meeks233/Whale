// Content script: find the right spot on a video page/post, mount the cloud
// download button, and run its lifecycle (download -> spinner -> ring ->
// cloud-check / X) off the background's progress pushes. All crypto/API lives in
// the background; this script only touches the DOM and messages.

import { glyphSvg, type GlyphName } from '../lib/glyphs.js';
import { isPrivateHost } from '../lib/net.js';
import { ringPercentForPhase } from '../lib/progress.js';
import type { BgResponse, Item, ProgressEvent, SubmitResult } from '../lib/types.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

type State = 'idle' | 'submitting' | 'progress' | 'success' | 'error' | 'canceled';

const buttons = new Map<number, OrcaButton>(); // itemId -> button
const decorated = new WeakSet<Element>();
// Mounted overlay buttons paired with their <video>. SPA sites (YouTube) reuse
// the same <video> element across navigations, so a rescan won't remount the
// button — we re-check these against the new URL when the location changes.
const mounted: { btn: OrcaButton; video: Element }[] = [];
// Hold the live progress ring just under full; a full ring is reserved for a
// real completion, so an in-flight download never reads as "done" (yt-dlp
// reports per-stream percent that hits 100 at the end of each stream).
const RUNNING_RING_MAX = 95;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Reveal an overlay button in lock-step with the native player controls: it
// appears while the pointer is anywhere over the video, fades a beat after the
// pointer leaves the player (like the controls do), and fades after a longer
// idle while the pointer rests on the player. Tracking the in/out transition —
// not just "seen a move here" — is what stops the button lingering in the corner
// after the controls have gone. One rAF-throttled document listener drives them.
interface OverlayReveal {
  rect: () => DOMRect;
  el: HTMLElement;
  inside: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}
const overlayReveals: OverlayReveal[] = [];
const CONTROLS_IDLE_MS = 2600; // resting on the player: match the native idle-hide
const CONTROLS_LEAVE_MS = 600; // pointer left the player: fade out with the controls

function revealShow(o: OverlayReveal): void {
  o.el.classList.add('orca-visible');
  if (o.leaveTimer) {
    clearTimeout(o.leaveTimer);
    o.leaveTimer = null;
  }
  if (o.idleTimer) clearTimeout(o.idleTimer);
  o.idleTimer = setTimeout(() => o.el.classList.remove('orca-visible'), CONTROLS_IDLE_MS);
}
function revealHideSoon(o: OverlayReveal): void {
  if (o.leaveTimer) return;
  if (o.idleTimer) {
    clearTimeout(o.idleTimer);
    o.idleTimer = null;
  }
  o.leaveTimer = setTimeout(() => {
    o.leaveTimer = null;
    o.el.classList.remove('orca-visible');
  }, CONTROLS_LEAVE_MS);
}

let revealListenerInstalled = false;
function installRevealListener(): void {
  if (revealListenerInstalled) return;
  revealListenerInstalled = true;
  let pending = false;
  let x = 0;
  let y = 0;
  const tick = (): void => {
    pending = false;
    for (const o of overlayReveals) {
      const r = o.rect();
      const nowInside =
        r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      if (nowInside) {
        o.inside = true;
        revealShow(o);
      } else if (o.inside) {
        o.inside = false;
        revealHideSoon(o);
      }
    }
  };
  document.addEventListener(
    'pointermove',
    (e) => {
      x = e.clientX;
      y = e.clientY;
      if (pending) return;
      pending = true;
      requestAnimationFrame(tick);
    },
    { passive: true },
  );
  // Pointer left the document entirely (no more moves will fire): fade all out.
  document.addEventListener(
    'pointerleave',
    () => {
      for (const o of overlayReveals)
        if (o.inside) {
          o.inside = false;
          revealHideSoon(o);
        }
    },
    { passive: true },
  );
}

async function send<T>(msg: unknown): Promise<T> {
  const resp = (await browser.runtime.sendMessage(msg)) as BgResponse<T>;
  if (!resp.ok) {
    const e = new Error(resp.error) as Error & { status?: number };
    e.status = resp.status;
    throw e;
  }
  return resp.data;
}

class OrcaButton {
  readonly el: HTMLButtonElement;
  private glyphEl: HTMLElement;
  private state: State = 'idle';
  private itemId: number | null = null;
  private slug: string | null = null;
  private url: string;
  private completed = false;
  private revertTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveUrl: (() => string) | null;
  // The on-page <video> this button decorates (overlay buttons only), so the
  // preview can be paused when its own download starts — see pauseOwnVideo.
  private videoEl: HTMLVideoElement | null;
  // Furthest-forward ring fraction seen this download, so live progress only ever
  // advances (see advanceFrac). Reset to 0 whenever a new download starts.
  private lastFrac = 0;
  // Whether a `video` phase frame has been seen this download, so a later `audio`
  // frame is mapped as the tail of a two-stream job (see advanceFrac). Reset with
  // lastFrac when a fresh download starts.
  private sawVideoPhase = false;

  constructor(url: string, resolveUrl?: () => string, video?: HTMLVideoElement) {
    this.url = url;
    this.resolveUrl = resolveUrl ?? null;
    this.videoEl = video ?? null;
    const el = document.createElement('button');
    el.className = 'orca-dl-btn';
    el.type = 'button';
    el.title = 'Download with Orca';
    el.setAttribute('aria-label', 'Download with Orca');
    el.dataset.state = 'idle';
    const glyphWrap = document.createElement('span');
    glyphWrap.className = 'orca-dl-glyph-wrap';
    // CSS border spinner (its own element) — replaces the rotating SVG stroke,
    // whose anti-aliased line-caps shimmered ("noise") while spinning.
    const spinner = document.createElement('span');
    spinner.className = 'orca-dl-spinner';
    el.appendChild(spinner);
    const ring = document.createElementNS(SVG_NS, 'svg');
    ring.setAttribute('class', 'orca-dl-ring');
    ring.setAttribute('viewBox', '0 0 24 24');
    ring.setAttribute('aria-hidden', 'true');
    for (const c of ['orca-dl-track', 'orca-dl-arc']) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('class', c);
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '12');
      circle.setAttribute('r', '10');
      ring.appendChild(circle);
    }
    el.appendChild(glyphWrap);
    el.appendChild(ring);
    // Hover-reveal cancel affordance: while a download is in flight, hovering the
    // button surfaces this X over the spinner/ring so a click stops the download
    // (the mature download-manager gesture — progress ring that turns into a stop
    // on hover). Hidden otherwise; CSS shows it only on :hover of an active state.
    const cancelWrap = document.createElement('span');
    cancelWrap.className = 'orca-dl-cancel';
    cancelWrap.appendChild(glyphSvg('x'));
    el.appendChild(cancelWrap);
    this.glyphEl = glyphWrap;
    this.setGlyph('cloudDownload');
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.onClick();
    });
    // Fully isolate the overlay from the player underneath. Stopping only `click`
    // still lets the earlier `pointerdown` / `mousedown` reach the host player:
    // YouTube's player listens for a press on the video surface, so a press that
    // lands on this button can trigger a stray play/pause/seek — which reads as
    // the playing video glitching or erroring the moment you hit download.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
    this.el = el;
  }

  private setGlyph(name: GlyphName): void {
    this.glyphEl.replaceChildren(glyphSvg(name));
  }

  private setState(s: State): void {
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.state = s;
    this.el.dataset.state = s;
    // Leaving the live ring (or re-entering the spinner) clears any "finalizing"
    // sweep — only an at-the-cap progress frame re-arms it (see advanceFrac).
    if (s !== 'progress') delete this.el.dataset.finalizing;
    if (s === 'idle') this.setGlyph('cloudDownload');
    else if (s === 'submitting') this.setGlyph('loader');
    else if (s === 'progress') this.setGlyph('cloudDownload');
    else if (s === 'success') this.setGlyph('cloudCheck');
    else if (s === 'canceled') this.setGlyph('retry');
    // `error` is two situations wearing one state: a server-side FAILED item we're
    // tracking (has a slug → retry glyph, parked, click re-runs it via /retry), and
    // a transient submit failure with no item (no slug → the X, which clears back to
    // idle so a fresh submit can be tried). A plain re-submit of a failed item is
    // deduped by the server and does nothing, so a known item must go through retry.
    else if (s === 'error') this.setGlyph(this.slug ? 'retry' : 'x');
    // Tooltip reflects what a click does in each state (in-flight → cancel; a
    // parked terminal → retry). Hover on an in-flight button reveals the cancel X.
    this.el.title =
      s === 'submitting' || s === 'progress'
        ? 'Cancel download'
        : s === 'canceled'
          ? 'Download canceled — click to retry'
          : s === 'error' && this.slug
            ? 'Download failed — click to retry'
            : s === 'success'
              ? 'Play in Orca'
              : 'Download with Orca';
    // Only the transient (no-item) submit failure clears itself back to idle; a
    // tracked failed/canceled item stays parked on retry until the user acts.
    if (s === 'error' && !this.slug) {
      this.revertTimer = setTimeout(() => {
        this.revertTimer = null;
        if (this.state === 'error') this.setState('idle');
      }, 2600);
    }
    // While a download is live, poll the backend for its real progress. This is
    // the AUTHORITATIVE sync — the pushed SSE frames are only a fast path. If a
    // push is dropped, the SSE stream drops, the background page suspends, or the
    // tab is backgrounded, the ring would otherwise freeze at its last frame
    // (commonly a full ring reading "100%" that never finishes). Every push
    // re-arms this timer, so a healthy push stream means it rarely fires; the
    // moment pushes go quiet it takes over and keeps the ring tracking the real
    // download, and it settles the button into its true end state.
    if (s === 'submitting' || s === 'progress') this.armPoll();
  }

  private armPoll(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => void this.syncProgress(), 2500);
  }

  private async syncProgress(): Promise<void> {
    this.stallTimer = null;
    if (this.state !== 'submitting' && this.state !== 'progress') return;
    if (!this.slug) return;
    try {
      const { item } = await send<{
        item: Item & { progress?: { percent: number | null; phase?: string | null } };
      }>({
        type: 'itemStatus',
        slug: this.slug,
      });
      if (item.status === 'completed' || item.status === 'duplicate') {
        this.completed = true;
        this.setFrac(100);
        this.setState('success');
        return;
      }
      if (item.status === 'canceled') {
        this.setState('canceled');
        return;
      }
      if (item.status === 'failed') {
        this.setState('error');
        return;
      }
      // Still working: reflect the server's live percent (capped so a per-stream
      // 100 never misreads as done), then keep polling.
      const pct = item.progress?.percent;
      if (pct != null && item.status === 'running') {
        this.setState('progress');
        this.advanceFrac(pct, item.progress?.phase);
      }
      this.armPoll();
    } catch {
      this.armPoll();
    }
  }

  private setFrac(percent: number | null): void {
    if (percent == null) this.sawVideoPhase = false; // fresh download — forget the phase
    const f = percent == null ? 0 : Math.max(0, Math.min(1, percent / 100));
    this.lastFrac = f;
    this.el.style.setProperty('--orca-frac', String(f));
  }

  // Live download progress that only ever moves forward. yt-dlp reports per-STREAM
  // percent: a `bv*+ba` download runs the video stream 0→100 then the audio stream
  // 0→100. Mapping each phase onto its own contiguous band (video → [0,85], audio →
  // [85,95]) turns the two passes into one honest, monotonic climb that keeps
  // advancing through the audio phase instead of freezing at the cap the instant
  // the video stream finishes. Held just shy of full (RUNNING_RING_MAX) so only a
  // real completion fills the ring.
  private advanceFrac(percent: number, phase?: string | null): void {
    if (phase === 'video') this.sawVideoPhase = true;
    const target = ringPercentForPhase(percent, phase, this.sawVideoPhase, RUNNING_RING_MAX);
    // At the running cap the transfer is essentially done and only yt-dlp's SILENT
    // postprocessing remains (merge + embed subs/thumbnail/metadata) — it emits no
    // more download frames, so the ring would otherwise sit frozen at 95% for the
    // whole finalize (the "stuck at 95%" report). Flag it so the ring sweeps a
    // "finalizing" spin instead of reading as dead.
    if (target >= RUNNING_RING_MAX) this.el.dataset.finalizing = '1';
    const f = target / 100;
    if (f > this.lastFrac) this.setFrac(target);
  }

  // Pause the on-page preview when its own download begins. Streaming a video in
  // the tab while the server fetches the SAME video can conflict — a second fetch
  // of the same stream (often from the same IP as a self-hosted server) plus the
  // local CPU/bandwidth contention makes the site's player error out ("something
  // went wrong") right as you hit download. You're saving it to Orca to watch
  // there anyway, so pausing the preview sidesteps the fight. Best-effort only.
  private pauseOwnVideo(): void {
    try {
      if (this.videoEl && !this.videoEl.paused) this.videoEl.pause();
    } catch {
      /* cross-origin / detached video — nothing we can do, and nothing to fix */
    }
  }

  // The button is one control whose click means different things per state — the
  // whole download state machine funnels through here:
  //   in-flight (submitting/progress) → CANCEL the download (hover shows the X)
  //   finished (success)              → PLAY the saved copy in the web app
  //   parked terminal with an item    → RETRY it (/retry re-queues; a plain submit
  //                                      would be deduped by the server and do nothing)
  //   idle / no item                  → fresh SUBMIT
  private async onClick(): Promise<void> {
    if (this.state === 'submitting' || this.state === 'progress') {
      await this.cancelDownload();
      return;
    }
    if (this.completed && this.slug) {
      await send({ type: 'openWebItem', slug: this.slug });
      return;
    }
    if (this.slug && (this.state === 'canceled' || this.state === 'error')) {
      await this.retryDownload();
      return;
    }
    await this.submitDownload();
  }

  // Fresh submit of the resolved URL (idle → in-flight).
  private async submitDownload(): Promise<void> {
    if (this.itemId != null) buttons.delete(this.itemId);
    this.itemId = null;
    this.slug = null;
    this.completed = false;
    this.setState('submitting');
    this.setFrac(null);
    this.lastFrac = 0;
    // Stop streaming the same video we're about to download (avoids the player
    // erroring mid-download — see pauseOwnVideo).
    this.pauseOwnVideo();
    try {
      // Resolve lazily at click time (the floating button on a feed page can only
      // pick the right video URL once one is on screen and playing).
      const url = this.resolveUrl?.() ?? this.url;
      const res = await send<SubmitResult>({ type: 'submit', url, tabWatch: true });
      this.adoptItem(res.item, res.duplicate);
    } catch (e) {
      this.setState('error');
      this.el.title = (e as Error).message || 'Submit failed';
    }
  }

  // Re-run an already-recorded failed/canceled item. Goes through /retry (not a
  // fresh submit, which the server dedups) so a download the user canceled or that
  // failed actually starts over.
  private async retryDownload(): Promise<void> {
    if (!this.slug) return this.submitDownload();
    const slug = this.slug;
    this.completed = false;
    this.setState('submitting');
    this.setFrac(null);
    this.lastFrac = 0;
    this.pauseOwnVideo();
    try {
      const { item } = await send<{ item: Item }>({ type: 'retryItem', slug, tabWatch: true });
      this.itemId = item.id;
      this.slug = item.slug;
      buttons.set(item.id, this);
      // Stay 'submitting' until progress pushes / the poll drive it forward.
    } catch (e) {
      this.setState('error');
      this.el.title = (e as Error).message || 'Retry failed';
    }
  }

  // Cancel the in-flight download. Optimistically park on retry; the poll / SSE
  // reconcile if the server disagrees. A no-op while the submit is still in flight
  // (no slug yet) — there's nothing to cancel until the item exists.
  private async cancelDownload(): Promise<void> {
    if (!this.slug) return;
    const slug = this.slug;
    this.setState('canceled');
    try {
      await send({ type: 'cancelItem', slug });
    } catch {
      /* leave it parked on retry; the next poll/refresh reflects the true state */
    }
  }

  // Fold a submit/lookup result item into the button's tracked state.
  private adoptItem(item: Item, duplicate = false): void {
    this.itemId = item.id;
    this.slug = item.slug;
    buttons.set(item.id, this);
    if (item.status === 'completed' || (duplicate && item.status === 'duplicate')) {
      this.completed = true;
      this.setFrac(100);
      this.setState('success');
    } else if (item.status === 'canceled') {
      this.setState('canceled');
    } else if (item.status === 'failed') {
      this.setState('error');
    } else if (item.status === 'running') {
      this.setState('progress');
    } else {
      // queued / paused — adopt as in-flight; the poll (armed by setState) tracks it.
      this.setState('submitting');
    }
  }

  // On mount, ask the server for this URL's latest item in ANY state (any=true) so
  // the button starts on the control that matches reality: the green tick for an
  // already-saved video, a retry glyph for one canceled/failed on another client,
  // or the live ring for one still downloading — not a plain download glyph that,
  // clicked, would be deduped and rejected.
  async checkExisting(): Promise<void> {
    if (this.state !== 'idle') return;
    try {
      const url = this.resolveUrl?.() ?? this.url;
      const { item } = await send<{ item: Item | null }>({ type: 'lookupItem', url, any: true });
      if (item && this.state === 'idle') this.adoptItem(item, item.status === 'duplicate');
    } catch {
      /* offline / not configured — leave the button idle */
    }
  }

  // Re-evaluate against the current page URL after an in-place (SPA) navigation
  // reused this button's <video> for a different video. An active download is
  // left alone; an idle/finished/errored button resets and re-checks so an
  // already-saved next video shows its tick (and a fresh one drops back to the
  // download glyph).
  async refresh(): Promise<void> {
    if (this.state === 'submitting' || this.state === 'progress') return;
    if (this.itemId != null) buttons.delete(this.itemId);
    this.itemId = null;
    this.slug = null;
    this.completed = false;
    this.setState('idle');
    this.setFrac(null);
    await this.checkExisting();
  }

  onProgress(ev: ProgressEvent): void {
    if (ev.status === 'running' && ev.percent != null) {
      this.setState('progress');
      this.advanceFrac(ev.percent, ev.phase);
    } else if (ev.status === 'queued' || ev.status === 'paused') {
      this.setState('submitting');
    } else if (ev.status === 'completed' || ev.status === 'duplicate') {
      this.completed = true;
      this.setFrac(100);
      this.setState('success');
    } else if (ev.status === 'canceled') {
      this.setState('canceled');
    } else if (ev.status === 'failed') {
      this.setState('error');
    }
  }
}

// ---- mounting ----

function mountVideoOverlays(): void {
  const videos = Array.from(document.querySelectorAll('video'));
  for (const v of videos) {
    if (decorated.has(v)) continue;
    const rect = v.getBoundingClientRect();
    if (rect.width < 220 || rect.height < 120) continue;
    const host = v.parentElement;
    if (!host) continue;
    decorated.add(v);
    // Anchor the button in a positioned wrapper over the video's top-LEFT,
    // aligned with YouTube's own top-left overlay affordances (the "More from"
    // channel chip lives there) rather than fighting the top-right controls.
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:absolute;top:8px;left:8px;z-index:2147483000;pointer-events:auto';
    const url = permalinkNear(v) ?? location.href;
    const btn = new OrcaButton(url, () => permalinkNear(v) ?? location.href, v as HTMLVideoElement);
    mounted.push({ btn, video: v });
    void btn.checkExisting();
    wrap.appendChild(btn.el);
    // Ensure the host can position the overlay.
    const pos = getComputedStyle(host).position;
    if (pos === 'static') host.style.position = 'relative';
    host.appendChild(wrap);
    // Track the native player controls: reveal whenever the pointer is over the
    // video and fade out once it leaves, so the button appears/disappears with
    // the controls instead of hogging the corner. (Active downloads force
    // themselves visible via CSS.)
    overlayReveals.push({
      rect: () => v.getBoundingClientRect(),
      el: btn.el,
      inside: false,
      idleTimer: null,
      leaveTimer: null,
    });
    installRevealListener();
  }
}

// ---- YouTube playlist thumbnails: persistent "already downloaded" tick ----
//
// Inside a YouTube playlist (the watch-page side panel and the /playlist page)
// every entry links to its own video. Mark the ones already in the Orca library
// with a small green check that stays put — no hover, unlike the overlay button
// — and leave un-downloaded entries completely untouched.
//
// Recognition is deliberately NON-BURSTY: lookups drain through a single
// throttled queue so a 200-item playlist never fires a wall of sealed requests
// at once. Results are cached by video id, so YouTube recycling these rows as
// you scroll repaints from cache instead of re-asking the server.
const isYouTube = /(^|\.)youtube\.com$/.test(location.hostname);
const YT_LOOKUP_INTERVAL = 140; // ms between playlist lookups — unhurried on purpose
const ytResult = new Map<string, boolean>(); // videoId -> downloaded?
const ytPending = new Map<string, Set<HTMLElement>>(); // videoId -> anchors awaiting a verdict
const ytQueue: string[] = [];
let ytPumping = false;

function ytVideoId(href: string): string | null {
  try {
    const u = new URL(href, location.href);
    if (!u.hostname.endsWith('youtube.com')) return null;
    const v = u.searchParams.get('v');
    return v && /^[\w-]{6,}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function paintYtTick(anchor: HTMLElement): void {
  if (anchor.querySelector(':scope > .orca-yt-tick')) return;
  const badge = document.createElement('span');
  badge.className = 'orca-yt-tick';
  badge.title = 'In your Orca library';
  badge.appendChild(glyphSvg('cloudCheck'));
  if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
  anchor.appendChild(badge);
}

// Drain the lookup queue one id at a time, spaced by YT_LOOKUP_INTERVAL. Each id
// is resolved once; every anchor still showing that id when the verdict lands
// gets its tick.
async function pumpYtQueue(): Promise<void> {
  if (ytPumping) return;
  ytPumping = true;
  while (ytQueue.length) {
    const id = ytQueue.shift()!;
    const waiting = ytPending.get(id);
    ytPending.delete(id);
    if (!ytResult.has(id)) {
      try {
        const { item } = await send<{ item: Item | null }>({
          type: 'lookupItem',
          url: `https://www.youtube.com/watch?v=${id}`,
        });
        ytResult.set(id, !!item);
      } catch {
        /* offline / not configured — leave uncached, a later scan may retry */
      }
    }
    if (ytResult.get(id) && waiting)
      for (const a of waiting) if (a.isConnected && a.dataset.orcaYt === id) paintYtTick(a);
    await sleep(YT_LOOKUP_INTERVAL);
  }
  ytPumping = false;
}

function scanYouTubePlaylists(): void {
  if (!isYouTube) return;
  const anchors = document.querySelectorAll<HTMLAnchorElement>(
    'ytd-playlist-panel-video-renderer a#thumbnail, ytd-playlist-video-renderer a#thumbnail',
  );
  for (const a of anchors) {
    const id = ytVideoId(a.href);
    if (!id) continue;
    if (a.dataset.orcaYt === id) continue; // already handled for this exact video
    // A recycled row now points at a different video: clear the stale tick.
    a.dataset.orcaYt = id;
    a.querySelector(':scope > .orca-yt-tick')?.remove();
    const known = ytResult.get(id);
    if (known === true) {
      paintYtTick(a);
    } else if (known === undefined) {
      let set = ytPending.get(id);
      if (!set) {
        set = new Set();
        ytPending.set(id, set);
        ytQueue.push(id);
      }
      set.add(a);
    }
    // known === false: not in the library — leave the thumbnail untouched.
  }
  if (ytQueue.length) void pumpYtQueue();
}

function isPermalinkPath(pathname: string): boolean {
  return (
    /\/(watch|video|status|p|reel|reels|comments|shorts|clip)\//.test(pathname) ||
    /\/status\/\d+/.test(pathname)
  );
}

// Best-effort permalink for a video: first a permalink ancestor <a>, else search
// the enclosing post/article container for one (x/reddit/etc. keep the canonical
// link on a timestamp anchor beside the media, not wrapping it).
function permalinkNear(el: Element): string | null {
  let node: Element | null = el;
  for (let i = 0; i < 8 && node; i++) {
    const a = node.closest('a[href]') as HTMLAnchorElement | null;
    if (a && isPermalinkPath(a.pathname)) return a.href;
    node = node.parentElement;
  }
  const container = el.closest(
    'article, [role="article"], [data-testid="tweet"], [data-testid="cellInnerDiv"], shreddit-post, .tweet',
  );
  if (container) {
    for (const link of Array.from(container.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
      if (isPermalinkPath(link.pathname)) return link.href;
    }
  }
  return null;
}

let features = { inpageButton: true };

function scan(): void {
  if (!features.inpageButton) return;
  mountVideoOverlays();
  scanYouTubePlaylists();
}

let scanTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleScan(): void {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, 400);
}

browser.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: string; event?: ProgressEvent };
  if (m.type === 'progress' && m.event) {
    buttons.get(m.event.id)?.onProgress(m.event);
  }
});

async function init(): Promise<void> {
  // Private / LAN pages (a router, NAS, localhost, the Orca server itself) aren't
  // downloadable sites — never recognise a video or mount the button there.
  if (isPrivateHost(location.hostname)) return;
  try {
    const cfg = await send<{ features: { inpageButton: boolean }; welcomeDone: boolean }>({
      type: 'getConfig',
    });
    features = cfg.features;
    if (!cfg.welcomeDone || !cfg.features.inpageButton) return;
  } catch {
    return;
  }
  scan();
  const obs = new MutationObserver(scheduleScan);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  // SPA navigations (YouTube etc.) don't reload — rescan on URL change.
  let last = location.href;
  setInterval(() => {
    if (location.href !== last) {
      last = location.href;
      scheduleScan();
      // Refresh buttons whose <video> the SPA reused for the new video (a rescan
      // skips them as already-decorated), and drop any whose video is now gone.
      for (let i = mounted.length - 1; i >= 0; i--) {
        const m = mounted[i]!;
        if (!m.video.isConnected) {
          mounted.splice(i, 1);
          // Drop the paired reveal too: left in place it keeps a strong ref to
          // the detached video/button (via its rect closure), leaking them and
          // wasting a getBoundingClientRect per pointermove frame on a dead node.
          const ri = overlayReveals.findIndex((o) => o.el === m.btn.el);
          if (ri >= 0) {
            const [o] = overlayReveals.splice(ri, 1);
            if (o!.idleTimer) clearTimeout(o!.idleTimer);
            if (o!.leaveTimer) clearTimeout(o!.leaveTimer);
          }
        } else void m.btn.refresh();
      }
    }
  }, 1000);
}

void init();
