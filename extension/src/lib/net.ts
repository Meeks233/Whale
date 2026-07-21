// Recognise hosts that aren't public, downloadable sites: loopback, LAN/private
// IP ranges, mDNS/private TLDs (.local, .internal, …) and bare single-label
// intranet names. The extension skips these — it neither mounts the in-page
// button nor offers a quick download for someone's router, NAS, or Orca server.
export function isPrivateHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  // IPv6 (URL.hostname may hand it back bracketed).
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true; // loopback / unspecified
    if (/^f[cd]/.test(host)) return true; // unique-local fc00::/7
    if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
    return false;
  }
  // IPv4.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // Hostnames.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) return true;
  if (!host.includes('.')) return true; // single-label intranet name
  return false;
}

// Does this URL look like a single, identifiable media permalink (one main
// video) rather than a feed / home / search / playlist page? Used by the popup's
// "Current page" card to decide whether it can confidently offer a download: we
// only recognise the well-known single-video shapes and treat everything else as
// ambiguous (so the popup falls back to cookies instead of guessing a download).
export function looksLikeMediaPage(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const p = u.pathname;
  if (host.endsWith('youtube.com'))
    return (p === '/watch' && u.searchParams.has('v')) || /^\/shorts\/[^/]/.test(p);
  if (host === 'youtu.be') return p.length > 1;
  return (
    /\/(watch|video|shorts|reel|reels|clip|episode|track)\/[^/]+/.test(p) ||
    /\/status\/\d+/.test(p) ||
    /\/p\/[^/]+/.test(p)
  );
}
