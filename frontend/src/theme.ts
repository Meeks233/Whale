// Apply a forced theme before first paint to avoid a light/dark flash.
try {
  const preference = localStorage.getItem('whale_theme');
  if (preference && preference !== 'system') {
    document.documentElement.setAttribute('data-theme', preference);
  }
} catch {
  // Storage can be unavailable in hardened/private browser contexts.
}
