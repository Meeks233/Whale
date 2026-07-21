// Lucide (lucide.dev) icons for the popup UI, as inline SVG. The exact same
// artwork the web dashboard uses, so the extension and the web app read as one
// product (see frontend/src/app.ts DOWNLOAD_SVG / RETRY_SVG / MORE_SVG / EYE_SVG /
// SVG_LOGIN / SVG_COOKIE / SVG_TRASH). We build real SVG nodes via DOMParser
// (never innerHTML on a live element) so this stays CSP- and lint-clean.

export type IconName =
  | 'externalLink'
  | 'gauge'
  | 'refresh'
  | 'download'
  | 'more'
  | 'eye'
  | 'eyeOff'
  | 'login'
  | 'cookie'
  | 'trash'
  | 'plus'
  | 'search'
  | 'x'
  | 'play';

// stroke icons share the lucide default attribute set; `more` is a filled kebab.
const STROKE =
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const ICONS: Record<IconName, string> = {
  externalLink: `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>`,
  gauge: `<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`,
  refresh: `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`,
  download: `<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>`,
  eye: `<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>`,
  eyeOff: `<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>`,
  login: `<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>`,
  cookie: `<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/>`,
  trash: `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>`,
  plus: `<path d="M5 12h14"/><path d="M12 5v14"/>`,
  search: `<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>`,
  x: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  more: `<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>`,
  play: `<polygon points="6 3 20 12 6 21 6 3"/>`,
};

// Icons drawn as solid fills rather than the shared lucide stroke set.
const FILLED = new Set<IconName>(['more', 'play']);

const parser = new DOMParser();

/** A lucide icon as a real <svg> node, class `orca-ico` (+ any extra classes). */
export function iconEl(name: IconName, cls = ''): SVGSVGElement {
  const attrs = FILLED.has(name) ? 'fill="currentColor"' : STROKE;
  const klass = ('orca-ico ' + cls).trim();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${attrs} ` +
    `class="${klass}" aria-hidden="true">${ICONS[name]}</svg>`;
  const doc = parser.parseFromString(svg, 'image/svg+xml');
  return doc.documentElement as unknown as SVGSVGElement;
}

/** Replace an element's contents with a lucide icon. */
export function setIcon(el: Element, name: IconName, cls = ''): void {
  el.replaceChildren(iconEl(name, cls));
}
