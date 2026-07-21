// The download-lifecycle glyphs, shared by the in-page button (as inline SVG)
// and the toolbar-icon state machine (rasterised onto an OffscreenCanvas).
// Path data is the exact lucide artwork the product spec calls for.

export type GlyphName = 'cloudDownload' | 'loader' | 'x' | 'cloudCheck' | 'retry';

export const GLYPH_PATHS: Record<GlyphName, string[]> = {
  cloudDownload: [
    'M12 13v8l-4-4',
    'm12 21 4-4',
    'M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284',
  ],
  loader: ['M21 12a9 9 0 1 1-6.219-8.56'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  // lucide refresh-cw — the retry affordance for a canceled download.
  retry: [
    'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
    'M21 3v5h-5',
    'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
    'M8 16H3v5',
  ],
  cloudCheck: [
    'm17 15-5.5 5.5L9 18',
    'M5.516 16.07A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 3.501 7.327',
  ],
};

/** lucide viewBox side length. */
export const GLYPH_VB = 24;

const SVG_NS = 'http://www.w3.org/2000/svg';

// Build a lucide glyph as real SVG nodes (no innerHTML) for the content script /
// popup. `currentColor` + CSS drive stroke/size. Only call in a DOM context.
export function glyphSvg(name: GlyphName, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', ('orca-glyph ' + cls).trim());
  for (const d of GLYPH_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

// Stroke a lucide glyph onto a 2D context sized `size`x`size`, `rotate` radians.
export function drawGlyph(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  name: GlyphName,
  size: number,
  color: string,
  rotate = 0,
): void {
  const scale = size / GLYPH_VB;
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);
  if (rotate) ctx.rotate(rotate);
  ctx.translate(-size / 2, -size / 2);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const d of GLYPH_PATHS[name]) ctx.stroke(new Path2D(d));
  ctx.restore();
}

// Draw a progress ring (track + arc) filling `frac` (0..1) of the circle.
export function drawRing(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  size: number,
  frac: number,
  color: string,
  track: string,
  // Radians to rotate the arc's start from 12 o'clock. Used to spin a near-full
  // ring during the silent "finalizing" postprocess so it doesn't read as frozen.
  rot = 0,
): void {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - Math.max(2, size * 0.11);
  ctx.clearRect(0, 0, size, size);
  ctx.lineWidth = Math.max(2, size * 0.12);
  ctx.lineCap = 'round';
  ctx.strokeStyle = track;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const clamped = Math.max(0, Math.min(1, frac));
  if (clamped > 0) {
    const start = -Math.PI / 2 + rot;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + clamped * Math.PI * 2);
    ctx.stroke();
  }
}
