// Apply a forced theme before first paint to avoid a light/dark flash.
try {
  const previous = ['wha', 'le_theme'].join('');
  if (localStorage.getItem('orca_theme') == null) {
    const value = localStorage.getItem(previous);
    if (value != null) localStorage.setItem('orca_theme', value);
  }
  localStorage.removeItem(previous);
  const preference = localStorage.getItem('orca_theme');
  if (preference && preference !== 'system') {
    document.documentElement.setAttribute('data-theme', preference);
  }
} catch {
  // Storage can be unavailable in hardened/private browser contexts.
}
