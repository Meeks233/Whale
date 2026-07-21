// Userscript entry point. Import order is load-bearing: the shim installs
// `globalThis.browser`, the fetch bridge and the CSS BEFORE detect.ts's module
// body runs (its top-level `browser.runtime.onMessage.addListener` and `init()`
// need the shim in place). ES module semantics + esbuild both preserve this
// order, so the shared content script boots unmodified against our shim.
import './shim.js';
import '../content/detect.js';
