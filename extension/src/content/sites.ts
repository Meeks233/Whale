// Site adapters — per-platform recognition of video permalinks and thumbnail
// anchors. One adapter answers two questions for the content script:
//
//   1. videoUrl(href): given a candidate link (a thumbnail, a hover-preview's
//      media link, or the page itself), is it a watchable video on this site, and
//      what is its STABLE canonical URL? This drives BOTH the overlay download
//      button's target (so a click on a hover-preview downloads the previewed
//      video, not the search page) and the "already saved" tick recognition.
//   2. thumbSelector: which anchors on the page are video thumbnails worth
//      checking for a tick.
//
// A GENERIC adapter recognises the common video-permalink URL shapes (so most
// sites — bilibili, x/twitter, reddit, vimeo, … — work with no per-site code).
// Explicit built-ins tune the awkward ones (YouTube: query-param ids, a distinct
// hover-preview link, lockup renderers). USER adapters, imported at runtime, add
// or override any site declaratively without a rebuild.

import type { UserSiteAdapter } from '../lib/types.js';

export type { UserSiteAdapter };

export interface SiteAdapter {
  id: string;
  /** CSS selector for thumbnail (image) anchors to consider for a tick. Empty =
   *  fall back to the generic image-anchor selector. */
  thumbSelector: string;
  /** Canonicalize a candidate href into the stable video URL Orca stores, or null
   *  if it isn't a watchable video on this site. */
  videoUrl(href: string): string | null;
}

// The declarative UserSiteAdapter shape (id, hosts, thumbSelector?, queryParam?,
// pathRegex?, canonical?) lives in lib/types.ts as a shared DTO — see there.

function parseUrl(href: string): URL | null {
  try {
    const u = new URL(href, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function hostMatches(hosts: string[], hostname: string): boolean {
  return hosts.some((h) => {
    const b = h.replace(/^\.+/, '').toLowerCase();
    return !!b && (hostname === b || hostname.endsWith('.' + b));
  });
}

// ---- generic permalink recognition (the no-per-site-code path) ----

// Path shapes that denote a single video/post across the common video & social
// sites. Deliberately anchored to a following id segment so bare section paths
// (/videos, /shorts) don't match.
const VIDEO_PATH_RE =
  /\/(watch|video|videos|v|w|embed|e|shorts|reel|reels|clip|clips|episode|play|media|status|p|tv)\/[^/?#]+/i;

// Canonicalize a generic video permalink: keep origin + path (drop tracking query
// and hash), except the /watch?v= shape whose id lives in the query.
export function genericVideoUrl(href: string): string | null {
  const u = parseUrl(href);
  if (!u) return null;
  const v = u.pathname === '/watch' ? u.searchParams.get('v') : null;
  if (v && /^[\w-]{4,}$/.test(v)) return `${u.origin}/watch?v=${v}`;
  if (VIDEO_PATH_RE.test(u.pathname) || /\/status\/\d+/.test(u.pathname)) {
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  }
  return null;
}

// Anchors that wrap a thumbnail image — the generic "is this a video card" signal.
// `:has()` is supported by current Chrome & Firefox (the only targets here).
const GENERIC_THUMB_SELECTOR = 'a:has(img), a:has(picture), a:has(canvas)';

const genericAdapter: SiteAdapter = {
  id: 'generic',
  thumbSelector: GENERIC_THUMB_SELECTOR,
  videoUrl: genericVideoUrl,
};

// ---- YouTube (query-param ids, distinct hover-preview link, lockup renderers) ----

function ytCanonical(id: string | null): string | null {
  return id && /^[\w-]{6,}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

function ytVideoUrl(href: string): string | null {
  const u = parseUrl(href);
  if (!u) return null;
  const h = u.hostname;
  if (h === 'youtu.be') return ytCanonical(u.pathname.slice(1).split('/')[0] || null);
  if (!/(^|\.)youtube\.com$/.test(h)) return null;
  if (u.pathname === '/watch') return ytCanonical(u.searchParams.get('v'));
  const m = u.pathname.match(/^\/(shorts|live|embed|v)\/([\w-]+)/);
  return m ? ytCanonical(m[2]!) : null;
}

const youtubeAdapter: SiteAdapter = {
  id: 'youtube',
  // Thumbnail-image anchors across YouTube's renderer generations: classic
  // `<a id="thumbnail">` (search / grid / older panels), the newer
  // `yt-lockup-view-model` design's content-image link (recs rail, mix/playlist),
  // and the vertical Shorts lockup. A Shorts card carries TWO anchors with the same
  // /shorts/<id> href — the poster and the title — so it is matched via `:has(img)`
  // to tick the thumbnail rather than the text (and to survive class churn).
  thumbSelector:
    'a#thumbnail[href], a.ytLockupViewModelContentImage[href], ' +
    'ytm-shorts-lockup-view-model a[href]:has(img)',
  videoUrl: ytVideoUrl,
};

const BUILTINS: { hosts: string[]; adapter: SiteAdapter }[] = [
  { hosts: ['youtube.com', 'youtu.be'], adapter: youtubeAdapter },
];

// ---- user adapter compilation ----

function compileUserAdapter(u: UserSiteAdapter): SiteAdapter | null {
  if (!Array.isArray(u.hosts) || u.hosts.length === 0) return null;
  const thumbSelector = u.thumbSelector || GENERIC_THUMB_SELECTOR;
  const build = (id: string | null): string | null => {
    if (!id || !u.canonical) return null;
    return u.canonical.replace('{id}', id);
  };
  let re: RegExp | null = null;
  if (u.pathRegex) {
    try {
      re = new RegExp(u.pathRegex);
    } catch {
      return null; // a bad regex disables the rule rather than throwing at scan time
    }
  }
  const videoUrl = (href: string): string | null => {
    const url = parseUrl(href);
    if (!url) return null;
    // Only claim links on this adapter's own hosts.
    if (!hostMatches(u.hosts, url.hostname)) return null;
    if (u.queryParam) {
      const built = build(url.searchParams.get(u.queryParam));
      if (built) return built;
    }
    if (re) {
      const m = url.pathname.match(re);
      const built = build(m?.[1] ?? null);
      if (built) return built;
    }
    // No explicit rule matched → fall back to the generic shape (scoped to host).
    return genericVideoUrl(href);
  };
  return { id: u.id || u.hosts[0]!, thumbSelector, videoUrl };
}

// Resolve the adapter for the current host: a user adapter first (users override
// built-ins), then a built-in, else the generic adapter.
export function resolveAdapter(hostname: string, userAdapters: UserSiteAdapter[]): SiteAdapter {
  for (const u of userAdapters) {
    if (hostMatches(u.hosts, hostname)) {
      const compiled = compileUserAdapter(u);
      if (compiled) return compiled;
    }
  }
  for (const b of BUILTINS) {
    if (hostMatches(b.hosts, hostname)) return b.adapter;
  }
  return genericAdapter;
}

// Validate + normalize a raw user-adapter list (from JSON import). Drops entries
// that can't compile so one bad row never breaks the rest.
export function sanitizeUserAdapters(raw: unknown): UserSiteAdapter[] {
  if (!Array.isArray(raw)) return [];
  const out: UserSiteAdapter[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const hosts = Array.isArray(o.hosts)
      ? o.hosts.filter((h): h is string => typeof h === 'string' && !!h.trim())
      : [];
    if (hosts.length === 0) continue;
    const a: UserSiteAdapter = { id: String(o.id ?? hosts[0]), hosts };
    if (typeof o.thumbSelector === 'string') a.thumbSelector = o.thumbSelector;
    if (typeof o.queryParam === 'string') a.queryParam = o.queryParam;
    if (typeof o.pathRegex === 'string') a.pathRegex = o.pathRegex;
    if (typeof o.canonical === 'string') a.canonical = o.canonical;
    if (compileUserAdapter(a)) out.push(a);
  }
  return out;
}
