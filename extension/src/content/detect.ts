// Content script: find the right spot on a video page/post, mount the cloud
// download button, and run its lifecycle (download -> spinner -> ring ->
// cloud-check / X) off the background's progress pushes. All crypto/API lives in
// the background; this script only touches the DOM and messages.

import { glyphSvg, type GlyphName } from '../lib/glyphs.js';
import { isPrivateHost } from '../lib/net.js';
import { ringPercentForPhase } from '../lib/progress.js';
import type { BgResponse, Item, ProgressEvent, Status, SubmitResult } from '../lib/types.js';
import { resolveAdapter, sanitizeUserAdapters, type SiteAdapter, type UserSiteAdapter } from './sites.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

type State = 'idle' | 'submitting' | 'progress' | 'success' | 'error' | 'canceled';

// The download state machine, once per canonical video URL — see DownloadState.
const track = new Map<string, DownloadState>(); // canonical url -> state
const byItem = new Map<number, DownloadState>(); // itemId -> state
const decorated = new WeakSet<Element>();
// Mounted overlay buttons paired with their <video>. SPA sites (YouTube) reuse
// the same <video> element across navigations, so a rescan won't remount the
// button — we re-check these against the new URL when the location changes.
const mounted: { btn: OrcaButton; video: Element; lastUrl: string }[] = [];
// Hold the live progress ring just under full; a full ring is reserved for a
// real completion, so an in-flight download never reads as "done" (yt-dlp
// reports per-stream percent that hits 100 at the end of each stream).
const RUNNING_RING_MAX = 95;
// Server statuses that mean the download has stopped for good — the server has
// spoken, so these are never suppressed by a pending cancel (see `canceling`).
const TERMINAL = new Set<Status>(['completed', 'duplicate', 'canceled', 'failed']);

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
// One-shot discoverability hint: flash the FIRST button that mounts on a page so
// a new user learns it exists, then it settles back to hover-only reveal.
let hintShown = false;

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

// One video can be shown by SEVERAL buttons at the same time: the one pinned onto
// its thumbnail once a download starts, and the transient one that remounts on the
// site's shared hover-preview player right after (promoteButton releases the video
// so hovering still works). They must never disagree — when each button owned its
// own state machine, cancelling from one and re-downloading from the other left the
// other stuck on a stale glyph (a dead "retry" over a live download, a spinner that
// never stopped).
//
// So the state machine lives HERE, exactly once per canonical video URL, and a
// button is only a VIEW of it: every click mutates this state, and the state
// re-renders all of its views. Two layers can't drift apart because there is only
// ever one state to drift.
class DownloadState {
  readonly url: string;
  state: State = 'idle';
  itemId: number | null = null;
  slug: string | null = null;
  completed = false;
  // Ring fill 0..1, and the "silent postprocessing" sweep flag — see advanceFrac.
  frac = 0;
  finalizing = false;
  // Tooltip for a submit/retry that failed outright (no item to retry).
  errorMsg: string | null = null;
  private views = new Set<OrcaButton>();
  private revertTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  // The server has already been asked what it knows about this URL (see
  // checkExisting) — every later view attaching to the same video reuses the answer
  // instead of re-querying.
  private lookedUp = false;
  // Whether a `video` phase frame has been seen this download, so a later `audio`
  // frame is mapped as the tail of a two-stream job (see advanceFrac).
  private sawVideoPhase = false;
  // The user asked to cancel and the server hasn't confirmed it yet. Two things
  // made a cancel need clicking twice, and this latch fixes both: a cancel clicked
  // before the submit response lands (no slug yet) is REMEMBERED and fired the
  // moment the item exists, and the `running` updates still in flight at that
  // moment — a queued push, or a poll that was already awaiting its answer — are
  // ignored instead of flipping the button back to a live ring.
  private canceling = false;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(url: string) {
    this.url = url;
  }

  static for(url: string): DownloadState {
    let s = track.get(url);
    if (!s) {
      s = new DownloadState(url);
      track.set(url, s);
    }
    return s;
  }

  attach(view: OrcaButton): void {
    this.views.add(view);
    view.render(this);
    void this.checkExisting();
  }

  detach(view: OrcaButton): void {
    this.views.delete(view);
    this.disposeIfDone();
  }

  // Forget a state nobody is showing any more. An in-flight download is KEPT even
  // with no views — its poll has to keep running so that hovering the thumbnail
  // again picks the live ring back up, and so the finished download still paints
  // its "saved" tick.
  private disposeIfDone(): void {
    if (this.views.size) return;
    if (this.state === 'submitting' || this.state === 'progress') return;
    if (this.revertTimer) clearTimeout(this.revertTimer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.revertTimer = this.stallTimer = this.cancelTimer = null;
    if (track.get(this.url) === this) track.delete(this.url);
    if (this.itemId != null && byItem.get(this.itemId) === this) byItem.delete(this.itemId);
  }

  // Repaint every button showing this video. Copied because a view can detach
  // itself while rendering (a pinned button retires on success).
  private emit(): void {
    for (const v of [...this.views]) v.render(this);
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
    // Leaving the live ring (or re-entering the spinner) clears any "finalizing"
    // sweep — only an at-the-cap progress frame re-arms it (see advanceFrac).
    if (s !== 'progress') this.finalizing = false;
    if (s !== 'error') this.errorMsg = null;
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
    this.emit();
    // Painted only after the views have rendered: the pinned button retires itself
    // on success, and paintTick defers while a live button occupies the thumbnail.
    if (s === 'success') markDownloaded(this.url);
    this.disposeIfDone();
  }

  private setFrac(percent: number | null): void {
    if (percent == null) this.sawVideoPhase = false; // fresh download — forget the phase
    this.frac = percent == null ? 0 : Math.max(0, Math.min(1, percent / 100));
    this.emit();
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
    if (target >= RUNNING_RING_MAX) this.finalizing = true;
    if (target / 100 > this.frac) this.setFrac(target);
    else this.emit();
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
      // This answer was asked for BEFORE the click and describes the download as it
      // was then — adopting it would resurrect the ring the cancel just dismissed.
      if (this.canceling && !TERMINAL.has(item.status)) return;
      if (TERMINAL.has(item.status)) this.canceling = false;
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

  // A click on ANY button showing this video. One control whose meaning depends on
  // the state — the whole download state machine funnels through here:
  //   in-flight (submitting/progress) → CANCEL the download (hover shows the X)
  //   finished (success)              → PLAY the saved copy in the web app
  //   parked terminal with an item    → RETRY it (/retry re-queues; a plain submit
  //                                      would be deduped by the server and do nothing)
  //   idle / no item                  → fresh SUBMIT
  async activate(): Promise<void> {
    // A cancel is already on its way. The extra clicks that follow one are
    // impatience, not a request to start over — without this they would land on the
    // freshly parked retry glyph and re-launch the download the user just stopped.
    if (this.canceling) return;
    if (this.state === 'submitting' || this.state === 'progress') return this.cancelDownload();
    if (this.completed && this.slug) {
      await send({ type: 'openWebItem', slug: this.slug });
      return;
    }
    if (this.slug && (this.state === 'canceled' || this.state === 'error'))
      return this.retryDownload();
    return this.submitDownload();
  }

  // Fresh submit (idle → in-flight).
  private async submitDownload(): Promise<void> {
    if (this.itemId != null) byItem.delete(this.itemId);
    this.itemId = null;
    this.slug = null;
    this.completed = false;
    this.canceling = false; // a fresh download supersedes any pending cancel
    this.setFrac(null);
    this.setState('submitting');
    try {
      const res = await send<SubmitResult>({ type: 'submit', url: this.url, tabWatch: true });
      this.adoptItem(res.item, res.duplicate);
    } catch (e) {
      this.errorMsg = (e as Error).message || 'Submit failed';
      this.setState('error');
    }
  }

  // Re-run an already-recorded failed/canceled item. Goes through /retry (not a
  // fresh submit, which the server dedups) so a download the user canceled or that
  // failed actually starts over.
  private async retryDownload(): Promise<void> {
    if (!this.slug) return this.submitDownload();
    const slug = this.slug;
    this.completed = false;
    this.canceling = false; // retrying supersedes the cancel that parked this item
    this.setFrac(null);
    this.setState('submitting');
    try {
      const { item } = await send<{ item: Item }>({ type: 'retryItem', slug, tabWatch: true });
      this.itemId = item.id;
      this.slug = item.slug;
      byItem.set(item.id, this);
      // Stay 'submitting' until progress pushes / the poll drive it forward.
    } catch (e) {
      this.errorMsg = (e as Error).message || 'Retry failed';
      this.setState('error');
    }
  }

  // Cancel the in-flight download. Park on retry immediately — a cancel has to LOOK
  // like it landed on the first click — and hold that appearance (see `canceling`)
  // until the server agrees. While the submit is still in flight there is no item to
  // cancel yet, so the intent is recorded and adoptItem fires it the instant one
  // exists, instead of the click doing nothing at all.
  private async cancelDownload(): Promise<void> {
    this.canceling = true;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
    this.setState('canceled');
    if (!this.slug) return;
    try {
      await send({ type: 'cancelItem', slug: this.slug });
      // The server writes the canceled status before killing yt-dlp, so the only
      // updates still coming are stragglers. Stop suppressing after they've drained,
      // so a lost final event can't leave the button permanently unclickable.
      this.cancelTimer = setTimeout(() => {
        this.cancelTimer = null;
        this.canceling = false;
      }, 5000);
    } catch {
      // The request never landed, so stop suppressing the server's updates and let
      // the true state (probably still running) show through again.
      this.canceling = false;
    }
  }

  // Fold a submit/lookup result item into the tracked state.
  private adoptItem(item: Item, duplicate = false): void {
    this.itemId = item.id;
    this.slug = item.slug;
    byItem.set(item.id, this);
    // A cancel clicked while this submit was still in flight now has something to
    // act on — honour it rather than starting to show progress the user has
    // already said they don't want.
    if (this.canceling && !TERMINAL.has(item.status)) {
      void this.cancelDownload();
      return;
    }
    this.canceling = false;
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

  // Ask the server for this URL's latest item in ANY state (any=true) so the button
  // starts on the control that matches reality: the green tick for an already-saved
  // video, a retry glyph for one canceled/failed on another client, or the live ring
  // for one still downloading — not a plain download glyph that, clicked, would be
  // deduped and rejected. Runs once per video, however many buttons show it.
  private async checkExisting(): Promise<void> {
    if (this.lookedUp || this.state !== 'idle') return;
    this.lookedUp = true;
    try {
      const { item } = await send<{ item: Item | null }>({
        type: 'lookupItem',
        url: this.url,
        any: true,
      });
      if (item && this.state === 'idle') this.adoptItem(item, item.status === 'duplicate');
    } catch {
      this.lookedUp = false; // offline / not configured — leave idle, a later mount retries
    }
  }

  onProgress(ev: ProgressEvent): void {
    // A cancel is pending: the download keeps reporting for a beat while the server
    // kills yt-dlp. Showing those frames would put the ring back and make the cancel
    // read as a missed click.
    if (this.canceling && !TERMINAL.has(ev.status)) return;
    if (TERMINAL.has(ev.status)) this.canceling = false;
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

// A button is a VIEW of the DownloadState for whatever video it currently covers.
// It owns no download state of its own — it renders what it is told and forwards
// clicks — so every button on a video (thumbnail-pinned + hover-preview) always
// shows the same thing.
class OrcaButton {
  readonly el: HTMLButtonElement;
  private glyphEl: HTMLElement;
  private glyph: GlyphName | null = null;
  private st: DownloadState;
  // Live URL resolver. On a feed/search page this points at the site's SHARED
  // hover-preview player, so it deliberately re-resolves to whatever is being
  // previewed right now — that's what lets one idle button serve every thumbnail.
  // Dropped once the button is pinned to a single thumbnail (see bindUrl).
  private resolveUrl: (() => string) | null;

  constructor(url: string, resolveUrl?: () => string) {
    this.resolveUrl = resolveUrl ?? null;
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
    this.st = DownloadState.for(url);
    this.st.attach(this);
  }

  private setGlyph(name: GlyphName): void {
    if (this.glyph === name) return; // renders run per progress frame — don't churn the DOM
    this.glyph = name;
    this.glyphEl.replaceChildren(glyphSvg(name));
  }

  // Paint whatever the shared state currently says. The ONLY place this button's
  // appearance is decided, so a thumbnail-pinned button and a hover-preview button
  // on the same video can never show different things.
  render(st: DownloadState): void {
    if (st !== this.st) return; // a stale state we've since detached from
    const s = st.state;
    this.el.dataset.state = s;
    if (s === 'progress' && st.finalizing) this.el.dataset.finalizing = '1';
    else delete this.el.dataset.finalizing;
    this.el.style.setProperty('--orca-frac', String(st.frac));
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
    else if (s === 'error') this.setGlyph(st.slug ? 'retry' : 'x');
    // Tooltip reflects what a click does in each state (in-flight → cancel; a
    // parked terminal → retry). Hover on an in-flight button reveals the cancel X.
    this.el.title =
      s === 'submitting' || s === 'progress'
        ? 'Cancel download'
        : s === 'error' && st.errorMsg
          ? st.errorMsg
          : s === 'canceled'
            ? 'Download canceled — click to retry'
            : s === 'error' && st.slug
              ? 'Download failed — click to retry'
              : s === 'success'
                ? 'Play in Orca'
                : 'Download with Orca';
    // From the first click onward the control has to stay on top of the thumbnail
    // (see promoteButton) — otherwise the spinner and ring live on the transient
    // hover-preview player and vanish the moment the pointer leaves.
    if (s === 'submitting' || s === 'progress') this.promote();
    // Finished: hand a pinned button back to the STATIC tick, so a freshly saved
    // video looks identical to one saved days ago (same small solid-green check)
    // instead of leaving the larger button styling behind.
    if (s === 'success') this.unpin();
  }

  private onClick(): void {
    // The shared preview player may have switched videos since the last scan —
    // re-point at what is under the pointer NOW, so the click can't act on the
    // previously previewed video.
    this.syncUrl();
    void this.st.activate();
  }

  // Re-point this button at the video it currently covers. Called on every scan and
  // SPA navigation: feed/search pages reuse ONE shared <video> for every thumbnail,
  // so the element never changes while the video it plays does. Re-attaching hands
  // the button the new video's state — an already-saved next video shows its tick, a
  // fresh one drops back to the download glyph, and a download still running on the
  // PREVIOUS video keeps its own state (its pinned button goes on showing the ring).
  syncUrl(): void {
    if (!this.resolveUrl) return; // pinned to one thumbnail (see bindUrl)
    const url = this.resolveUrl();
    if (url === this.st.url) return;
    this.st.detach(this);
    this.st = DownloadState.for(url);
    this.st.attach(this);
  }

  // Lift this button out of the throwaway preview player and onto the thumbnail it
  // covers. Done once — `promoted` latches so repeated progress frames don't
  // re-query the DOM.
  private promoted = false;
  private promote(): void {
    if (this.promoted) return;
    const entry = mounted.find((m) => m.btn === this);
    if (!entry) return;
    const before = this.el.parentElement?.parentElement;
    promoteButton(this, this.st.url, entry.video);
    if (this.el.parentElement?.parentElement !== before) {
      this.promoted = true;
      this.bindUrl();
    }
  }

  // Pin this button to ONE video for good.
  //
  // Vital on a feed/search page: `resolveUrl` reads the site's SHARED hover-preview
  // player, so it tracks whatever the pointer is over. A button that has been
  // promoted onto a thumbnail no longer sits on that player, so it must stop
  // following it — otherwise the row's status light would be dragged onto whatever
  // video the pointer wandered to next.
  private bindUrl(): void {
    this.resolveUrl = null;
  }

  // Retire a pinned button from its thumbnail, leaving the row to the static tick.
  // The wrapper (and this view) leave the DOM, so drop it from the state's views.
  private unpin(): void {
    if (!this.promoted) return;
    this.promoted = false;
    this.el.classList.remove('orca-pinned');
    this.el.parentElement?.remove(); // the positioned wrapper promoteButton moved
    this.st.detach(this);
  }

  // This button is gone (its <video> left the page): stop being a view of its
  // state, so nothing keeps the dead button — or the state — alive.
  dispose(): void {
    this.st.detach(this);
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
    const url = resolveVideoUrl(v);
    const btn = new OrcaButton(url, () => resolveVideoUrl(v));
    mounted.push({ btn, video: v, lastUrl: url });
    wrap.appendChild(btn.el);
    // Ensure the host can position the overlay.
    const pos = getComputedStyle(host).position;
    if (pos === 'static') host.style.position = 'relative';
    host.appendChild(wrap);
    // Track the native player controls: reveal whenever the pointer is over the
    // video and fade out once it leaves, so the button appears/disappears with
    // the controls instead of hogging the corner. (Active downloads force
    // themselves visible via CSS.)
    const reveal: OverlayReveal = {
      rect: () => v.getBoundingClientRect(),
      el: btn.el,
      inside: false,
      idleTimer: null,
      leaveTimer: null,
    };
    overlayReveals.push(reveal);
    installRevealListener();
    // First-mount hint: flash the first button visible for a beat (reusing the
    // reveal's own idle-hide timing) so a new user sees it, then it returns to
    // appearing only on hover. A live download still forces itself visible via CSS.
    if (!hintShown) {
      hintShown = true;
      revealShow(reveal);
    }
  }
}

// ---- video thumbnails: persistent "already downloaded" tick ----
//
// Every video thumbnail across a site — search results, the recommendations rail,
// playlist rows, the home/subscriptions grid — links to its own video. Mark the
// ones already in the Orca library with a small green check that stays put (no
// hover, unlike the overlay button) and leave un-downloaded entries untouched.
//
// WHICH anchors count as thumbnails, and HOW to turn a link into the stable video
// URL Orca stores, both come from the active SiteAdapter (see ./sites.ts). So the
// same code ticks YouTube (query-param ids, lockup renderers), the generic
// video-permalink sites (bilibili, x, reddit, vimeo, …) recognised by URL shape,
// and any user-imported platform — no per-site branches here.
//
// Recognition is NON-BURSTY and CHEAP: unresolved URLs drain through a queue that
// resolves a whole BATCH per sealed request (one round-trip for a grid, not one
// lookup per row). Results cache by canonical URL, so recycling rows as you scroll
// repaints from cache instead of re-asking the server.
let adapter: SiteAdapter = resolveAdapter(location.hostname, []);
const THUMB_BATCH_MAX = 200; // urls per sealed lookup (server caps at 256)
const THUMB_BATCH_INTERVAL = 200; // ms between batches — unhurried, rarely reached
const thumbResult = new Map<string, boolean>(); // canonicalUrl -> downloaded?
const thumbPending = new Map<string, Set<HTMLElement>>(); // canonicalUrl -> anchors awaiting a verdict
const thumbQueue: string[] = [];
let thumbPumping = false;

// Open the saved copy of a video in the Orca web app. The tick only knows the
// video's canonical URL (the batch check answers "downloaded?", not with what
// slug), so resolve the slug on demand — one lookup, and only when actually
// clicked.
async function openSavedVideo(url: string): Promise<void> {
  if (!url) return;
  try {
    const { item } = await send<{ item: Item | null }>({ type: 'lookupItem', url });
    if (item?.slug) await send({ type: 'openWebItem', slug: item.slug });
  } catch {
    /* offline / not configured — nothing to open */
  }
}

function paintTick(anchor: HTMLElement): void {
  if (anchor.querySelector(':scope > .orca-yt-tick')) return;
  // A live download button promoted onto this thumbnail already reports the state
  // (and is interactive) — don't stack a static tick behind it.
  if (anchor.querySelector('.orca-dl-btn')) return;
  const badge = document.createElement('span');
  badge.className = 'orca-yt-tick';
  badge.title = 'In your Orca library — click to play';
  badge.appendChild(glyphSvg('cloudCheck'));
  // The tick is the ONLY affordance on a saved thumbnail (the download button has
  // handed off to it), so it must open the saved copy. It sits INSIDE the
  // thumbnail's <a>, so every pointer event has to be stopped or the click would
  // navigate to the video page instead of playing our copy.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) {
    badge.addEventListener(type, (e) => e.stopPropagation());
  }
  badge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openSavedVideo(anchor.dataset.orcaThumb ?? '');
  });
  if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
  anchor.appendChild(badge);
}

// Drain the lookup queue a BATCH at a time, resolving up to THUMB_BATCH_MAX URLs
// in a single sealed request and spacing batches by THUMB_BATCH_INTERVAL. Each URL
// is resolved once; every anchor still showing that URL when the verdict lands
// gets its tick.
async function pumpThumbQueue(): Promise<void> {
  if (thumbPumping) return;
  thumbPumping = true;
  while (thumbQueue.length) {
    // Peel off a batch of still-unresolved URLs.
    const batch: string[] = [];
    while (thumbQueue.length && batch.length < THUMB_BATCH_MAX) {
      const url = thumbQueue.shift()!;
      if (!thumbResult.has(url)) batch.push(url);
    }
    if (batch.length) {
      try {
        const { downloaded } = await send<{ downloaded: string[] }>({
          type: 'lookupBatch',
          urls: batch,
        });
        const saved = new Set(downloaded);
        for (const url of batch) thumbResult.set(url, saved.has(url));
      } catch {
        /* offline / not configured — leave uncached, a later scan may retry */
      }
      for (const url of batch) {
        const waiting = thumbPending.get(url);
        thumbPending.delete(url);
        if (thumbResult.get(url) && waiting)
          for (const a of waiting) if (a.isConnected && a.dataset.orcaThumb === url) paintTick(a);
      }
    }
    if (thumbQueue.length) await sleep(THUMB_BATCH_INTERVAL);
  }
  thumbPumping = false;
}

function scanThumbs(): void {
  if (!adapter.thumbSelector) return;
  let anchors: NodeListOf<HTMLAnchorElement>;
  try {
    anchors = document.querySelectorAll<HTMLAnchorElement>(adapter.thumbSelector);
  } catch {
    return; // a malformed user selector must not break the scan
  }
  for (const a of anchors) {
    const url = adapter.videoUrl(a.href);
    if (!url) continue;
    if (a.dataset.orcaThumb === url) {
      // Already handled for this exact video — but the site re-renders these rows
      // (a hover preview tearing down, a virtualized list repainting) and wipes our
      // badge with it. Repaint from cache when it has gone missing, otherwise a
      // just-downloaded video only shows its tick again after a full page reload.
      if (thumbResult.get(url) === true) paintTick(a);
      continue;
    }
    // A recycled row now points at a different video: clear the stale tick.
    a.dataset.orcaThumb = url;
    a.querySelector(':scope > .orca-yt-tick')?.remove();
    const known = thumbResult.get(url);
    if (known === true) {
      paintTick(a);
    } else if (known === undefined) {
      let set = thumbPending.get(url);
      if (!set) {
        set = new Set();
        thumbPending.set(url, set);
        thumbQueue.push(url);
      }
      set.add(a);
    }
    // known === false: not in the library — leave the thumbnail untouched.
  }
  if (thumbQueue.length) void pumpThumbQueue();
}

function thumbAnchors(): HTMLAnchorElement[] {
  if (!adapter.thumbSelector) return [];
  try {
    return Array.from(document.querySelectorAll<HTMLAnchorElement>(adapter.thumbSelector));
  } catch {
    return []; // a malformed user selector must not break anything
  }
}

// Record a just-finished download as saved and paint its persistent tick on any
// matching thumbnail already on the page (the search/feed row the button was
// clicked from). Keyed by the same canonical URL the tick scan uses, so a later
// rescan repaints from cache instead of re-asking the server.
function markDownloaded(url: string): void {
  if (!url) return;
  thumbResult.set(url, true);
  for (const a of thumbAnchors()) {
    if (adapter.videoUrl(a.href) === url) {
      a.dataset.orcaThumb = url;
      paintTick(a);
    }
  }
}

// Fraction of the SMALLER rect that the two share. Used to pair a hover-preview
// player with the thumbnail it is covering.
function overlapRatio(a: DOMRect, b: DOMRect): number {
  const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (ix <= 0 || iy <= 0) return 0;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? (ix * iy) / smaller : 0;
}

// The thumbnail this <video> is visually sitting on top of, if any. Matched by
// GEOMETRY rather than DOM ancestry on purpose: sites commonly mount the hover
// preview as a GLOBAL overlay element (YouTube's `ytd-video-preview` lives outside
// the result card entirely) that merely positions itself over the thumbnail.
function thumbUnderVideo(video: Element, url: string): HTMLAnchorElement | null {
  const vr = video.getBoundingClientRect();
  if (vr.width < 1 || vr.height < 1) return null;
  for (const a of thumbAnchors()) {
    if (adapter.videoUrl(a.href) !== url) continue;
    if (overlapRatio(vr, a.getBoundingClientRect()) > 0.6) return a;
  }
  return null;
}

// Once a download is under way its control must stay VISIBLE and ON TOP. The
// button is mounted on the hover-preview player, which the site tears down (or
// restacks beneath the still image) the moment the pointer leaves — taking the
// spinner/ring/check with it, so progress could only be seen by holding a hover.
// Re-parent it onto the thumbnail anchor instead: a stable element that paints
// above the still image, so the whole download lifecycle stays in view at rest.
// The live button supersedes the static tick, so any tick there is removed.
function promoteButton(btn: OrcaButton, url: string, video: Element): void {
  const wrap = btn.el.parentElement;
  if (!wrap) return;
  const anchor = thumbUnderVideo(video, url);
  if (!anchor || wrap.parentElement === anchor) return;
  // One status light per row. The replacement button we let mount on the shared
  // preview player below also adopts the in-flight item, so without this it would
  // promote too — re-releasing the video and piling a new pinned button onto this
  // thumbnail on every scan.
  if (anchor.querySelector('.orca-dl-btn')) return;
  if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
  anchor.querySelector(':scope > .orca-yt-tick')?.remove();
  anchor.appendChild(wrap);
  // Pinned to a thumbnail: this button is now that row's persistent status light,
  // so it stays visible at rest in every state (see inject.css). On a real player
  // the button is NOT pinned and keeps fading with the native controls.
  btn.el.classList.add('orca-pinned');

  // The preview player is a SHARED element the site reuses for EVERY thumbnail
  // (YouTube keeps one global `ytd-video-preview`). Now that this button has moved
  // off it, release the video so the next scan mounts a fresh button on it —
  // otherwise hovering any thumbnail afterwards would show no download button at
  // all, and the pinned button would be dragged around by the shared player.
  decorated.delete(video);
  const mi = mounted.findIndex((m) => m.btn === btn);
  if (mi >= 0) mounted.splice(mi, 1);
  const ri = overlayReveals.findIndex((o) => o.el === btn.el);
  if (ri >= 0) {
    const [o] = overlayReveals.splice(ri, 1);
    if (o!.idleTimer) clearTimeout(o!.idleTimer);
    if (o!.leaveTimer) clearTimeout(o!.leaveTimer);
  }
}

// Resolve the canonical video URL for a mounted <video>. The nearest surrounding
// link the adapter recognises as a video is what makes a click on a HOVER PREVIEW
// download the previewed video (its media link sits just above the <video>) rather
// than the search/feed page. Falling back to the enclosing post's permalink covers
// x/reddit (the link is a timestamp anchor beside the media, not wrapping it); the
// page URL itself covers a watch page's own primary player.
function resolveVideoUrl(el: Element): string {
  let node: Element | null = el;
  for (let i = 0; i < 10 && node; i++) {
    const a = node.closest('a[href]') as HTMLAnchorElement | null;
    if (!a) break;
    const u = adapter.videoUrl(a.href);
    if (u) return u;
    node = a.parentElement;
  }
  const container = el.closest(
    'article, [role="article"], [data-testid="tweet"], [data-testid="cellInnerDiv"], shreddit-post, .tweet',
  );
  if (container) {
    for (const link of Array.from(container.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
      const u = adapter.videoUrl(link.href);
      if (u) return u;
    }
  }
  return adapter.videoUrl(location.href) ?? location.href;
}

let features = { inpageButton: true };

// A shared hover-preview player is reused for EVERY thumbnail on a feed/search
// page: the same <video> element silently becomes a different video as the pointer
// moves, with no navigation to react to. A button left sitting on it keeps showing
// the PREVIOUS video's state — which is why, after one download finished, hovering
// any other thumbnail showed that download's green check. Detect the identity
// change and re-point the button at the new video's state. A download running on
// the video it just left is untouched — that state lives on independently and its
// pinned button keeps showing the ring.
function syncMountedIdentity(): void {
  for (const m of mounted) {
    if (!m.video.isConnected) continue;
    const url = resolveVideoUrl(m.video);
    if (url === m.lastUrl) continue;
    m.lastUrl = url;
    m.btn.syncUrl();
  }
}

function scan(): void {
  if (!features.inpageButton) return;
  mountVideoOverlays();
  syncMountedIdentity();
  scanThumbs();
}

// Swap in the adapter set for freshly imported user rules (dynamic import), forget
// cached verdicts, and re-scan from scratch. Keyed on the serialized rule list so a
// no-op refresh costs nothing.
let adaptersKey = '';
function applyAdapters(userAdapters: UserSiteAdapter[]): void {
  const key = JSON.stringify(userAdapters);
  if (key === adaptersKey) return;
  adaptersKey = key;
  adapter = resolveAdapter(location.hostname, userAdapters);
  thumbResult.clear();
  thumbPending.clear();
  thumbQueue.length = 0;
  for (const a of Array.from(document.querySelectorAll<HTMLElement>('[data-orca-thumb]'))) {
    delete a.dataset.orcaThumb;
    a.querySelector(':scope > .orca-yt-tick')?.remove();
  }
  if (started) scan();
}

async function refreshAdapters(): Promise<void> {
  try {
    const cfg = await send<{ siteAdapters?: UserSiteAdapter[] }>({ type: 'getConfig' });
    applyAdapters(sanitizeUserAdapters(cfg.siteAdapters ?? []));
  } catch {
    /* offline / not configured — keep the current adapter */
  }
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
    byItem.get(m.event.id)?.onProgress(m.event);
  }
});

// Begin watching the page for videos. Idempotent — only the first call wires up
// the scan, the mutation observer, and the SPA-navigation watcher.
let started = false;
function start(): void {
  if (started) return;
  started = true;
  scan();
  const obs = new MutationObserver(scheduleScan);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  // SPA navigations (YouTube etc.) don't reload — rescan on URL change. Also
  // periodically re-fetch user site adapters so a NEWLY IMPORTED platform takes
  // effect on already-open tabs without a reload (dynamic import). getConfig is a
  // cheap local read (storage / GM store), never a network round-trip.
  let last = location.href;
  let ticks = 0;
  setInterval(() => {
    if (++ticks % 15 === 0) void refreshAdapters();
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
          // Let go of the state too, so a video nobody is showing any more stops
          // being tracked (an in-flight one is kept — see disposeIfDone).
          m.btn.dispose();
        } else {
          m.lastUrl = resolveVideoUrl(m.video);
          m.btn.syncUrl();
        }
      }
    }
  }, 1000);
}

// Ask the background/shim for config; start watching once the connection is set
// up and the in-page button is enabled. Returns true once started.
async function tryStart(): Promise<boolean> {
  try {
    const cfg = await send<{
      features: { inpageButton: boolean };
      welcomeDone: boolean;
      siteAdapters?: UserSiteAdapter[];
    }>({
      type: 'getConfig',
    });
    features = cfg.features;
    applyAdapters(sanitizeUserAdapters(cfg.siteAdapters ?? []));
    if (!cfg.welcomeDone || !cfg.features.inpageButton) return false;
  } catch {
    return false;
  }
  start();
  return true;
}

async function init(): Promise<void> {
  // Private / LAN pages (a router, NAS, localhost, the Orca server itself) aren't
  // downloadable sites — never recognise a video or mount the button there.
  if (isPrivateHost(location.hostname)) return;
  if (await tryStart()) return;
  // Not configured yet. The user may set the server/token LATER — in the web
  // dashboard (the userscript mirrors it) or the popup — without reloading this
  // tab. Re-check on an interval so the button appears on its own once
  // credentials land, instead of silently requiring a manual page reload.
  const poll = setInterval(() => {
    void tryStart().then((ok) => {
      if (ok) clearInterval(poll);
    });
  }, 3000);
}

void init();
