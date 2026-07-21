// Shared DTOs (mirrors of the Rust `src/types.rs` shapes we consume) and the
// runtime-message protocol between the content script / popup and the background.

export type Status =
  | 'queued'
  | 'running'
  | 'paused'
  | 'canceled'
  | 'completed'
  | 'failed'
  | 'duplicate';

export interface Item {
  id: number;
  slug: string;
  status: Status;
  url?: string;
  title?: string | null;
  site_name?: string | null;
  /** Server-computed privacy-blur flag for this item's site (true when the item's
   *  host belongs to a blur-on website, matched across all its related hosts). */
  blur?: boolean;
  /** Recorded upstream thumbnail URL. Non-empty means a preview is available via
   *  the E2EE `/thumb` proxy (fetched + decrypted by the background). */
  thumbnail_url?: string | null;
}

export interface SubmitResult {
  item: Item;
  duplicate: boolean;
}

export interface ProgressEvent {
  id: number;
  status: Status;
  percent: number | null;
  speed: string | null;
  eta: string | null;
  phase?: string | null;
}

export interface CookieStatus {
  present: boolean;
  enabled: boolean;
  bytes: number;
  updated_at: number;
  expires_at?: number | null;
}

export interface Website {
  key: string;
  name: string;
  hosts: string[];
  login_url: string;
  enabled: boolean;
  max_heights: string | null;
  stream_quality: string | null;
  container: string | null;
  subs: boolean | null;
  blur: boolean;
  blur_default: boolean;
  sort: number;
  cookie?: CookieStatus | null;
}

// Persisted config (browser.storage.local).
export interface StoredConfig {
  base: string;
  token: string;
  welcomeDone: boolean;
  features: FeatureFlags;
}

export interface FeatureFlags {
  /** Reflect the active download's state machine on the toolbar button icon
   *  (download -> spinner -> progress ring -> cloud-check / X). Default surface. */
  toolbarStatus: boolean;
  /** Inject the cloud-download button onto video pages / posts. */
  inpageButton: boolean;
  /** Website-management tab in the popup. */
  websiteManagement: boolean;
}

// ---- Messages: content/popup -> background (request) ----

export type BgRequest =
  | { type: 'getConfig' }
  | { type: 'setConnection'; base: string; token: string }
  | { type: 'validate'; base: string; token: string }
  | { type: 'setFeatures'; features: Partial<FeatureFlags> }
  | { type: 'submit'; url: string; tabWatch?: boolean }
  | { type: 'itemStatus'; slug: string }
  | { type: 'cancelItem'; slug: string }
  | { type: 'retryItem'; slug: string; tabWatch?: boolean }
  | { type: 'deleteItem'; slug: string }
  | { type: 'lookupItem'; url: string; any?: boolean }
  | { type: 'listItems'; limit?: number }
  | { type: 'thumb'; slug: string }
  | { type: 'extractCookies'; url: string }
  | { type: 'listWebsites' }
  | { type: 'upsertWebsite'; key: string; body: Record<string, unknown> }
  | { type: 'deleteWebsite'; key: string }
  | { type: 'setCookies'; key: string; cookies: string }
  | { type: 'toggleCookies'; key: string; enabled: boolean }
  | { type: 'deleteCookies'; key: string }
  | { type: 'openDashboard' }
  | { type: 'openWebItem'; slug: string };

export type BgResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

// ---- Messages: background -> content (push) ----

export interface ProgressPush {
  type: 'progress';
  event: ProgressEvent;
}
