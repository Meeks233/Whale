// Demo data for Play/F-Droid store screenshots.
//
// Store listings must never show a real library: the dev database holds real
// downloads (real titles, real uploaders, sometimes adult content), none of
// which belongs in a public listing. This stubs `fetch` BEFORE the app boots so
// the UI renders a curated, fictional library instead — the app itself is
// unmodified and unaware.
//
// Use as chrome-devtools `navigate_page({initScript})`; see
// docs/RELEASING_ANDROID.md § Screenshots for the full capture recipe.
(() => {
  const THUMB = '/icons/512.png'; // bundled asset: no network, no real artwork

  const item = (id, title, uploader, opts = {}) => ({
    id,
    slug: 'demo' + String(id).padStart(28, '0'),
    status: 'completed',
    title,
    uploader,
    extractor: opts.extractor || 'twitter',
    site_name: opts.site_name || 'X',
    video_id: 'demo' + id,
    thumbnail_url: THUMB,
    webpage_url: 'https://example.com/watch?v=demo' + id,
    duration: opts.duration ?? 30,
    filesize: opts.filesize ?? 3_600_000,
    total_filesize: opts.filesize ?? 3_600_000,
    height: opts.height ?? 720,
    local_available: true,
    blur: false,
    public: false,
    public_hits: 0,
    created_at: 1_780_000_000 - id * 3600,
    completed_at: 1_780_000_000 - id * 3600,
    ...opts.extra,
  });

  const ITEMS = [
    item(1, 'Open source conference highlights', 'Community Media', {
      duration: 58, height: 1080, extra: { status: 'running', local_available: false },
    }),
    item(2, 'City walking tour', 'Northbound Studio', { duration: 10, filesize: 3_600_000, height: 720 }),
    item(3, 'Home cooking: seasonal vegetables', 'Kitchen Notes', { duration: 35, filesize: 9_200_000, height: 1080 }),
    item(4, 'Product design workshop', 'Design Commons', { duration: 9, filesize: 1_500_000, height: 1080 }),
    item(5, 'Piano practice session', 'Open Sessions', { duration: 21, filesize: 729_000, height: 480 }),
    item(6, 'Weekend cycling route', 'Trail Journal', { duration: 68, filesize: 6_700_000, height: 720 }),
    item(7, 'Field recording: coastal birds', 'Nature Archive', { duration: 142, filesize: 12_100_000, height: 720 }),
  ];

  const STATS = { count: 12, total_bytes: 1_932_735_283 }; // "12 files · 1.8 GB"

  // The Settings screen renders the yt-dlp archive and the error log verbatim —
  // both are real user history (real video ids, real failures), so both are
  // replaced with representative fictional lines.
  const ARCHIVE_KEYS = [
    'youtube dQw4w9WgXcQ',
    'youtube kJQP7kiw5Fk',
    'twitter 1750000000000000001',
    'vimeo 76979871',
    'soundcloud 1234567890',
  ];

  const LOGS = [
    { at: 1_780_000_000, stage: 'probe', platform: 'youtube', message: 'probe failed: video is private' },
    { at: 1_779_996_400, stage: 'download', platform: 'twitter', message: 'download failed: HTTP Error 429: Too Many Requests' },
  ];

  const json = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const path = url.split('?')[0];
    if (path.endsWith('/api/items')) return Promise.resolve(json({ items: ITEMS, next_cursor: null }));
    if (path.endsWith('/api/stats')) return Promise.resolve(json(STATS));
    if (path.endsWith('/api/archive')) return Promise.resolve(json({ keys: ARCHIVE_KEYS }));
    if (path.endsWith('/api/logs')) return Promise.resolve(json({ entries: LOGS, capacity: 100 }));
    // Everything else (settings, websites, assets) is served for real: those
    // screens contain no user data.
    return real(input, init);
  };

  // The SSE stream would immediately overwrite the demo "running" row with real
  // state, so keep it closed for the capture.
  window.EventSource = class {
    constructor() { this.readyState = 0; }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };

  localStorage.setItem('token', 'test-token');
  localStorage.setItem('orca_token', 'test-token');
})();
