// ---- Lightweight i18n -----------------------------------------------------
// A tiny, dependency-free localization layer modelled on the common
// "flat key → string, {var} interpolation, navigator.languages detection"
// pattern (i18next-lite / vue-i18n in spirit). English is the source of truth;
// missing keys in a locale fall back to English, then to the raw key.
//
// Adding a language later is just another entry in LANGS + DICT — the pie is
// drawn here so a full global rollout can slot straight in.
//
// Side-effect module: importing it installs `window.i18n` (see app.ts). The
// bundler concatenates it ahead of app.ts so the global is ready synchronously.

export interface LangMeta { label: string }
export type LangCode = string;
export type Params = Record<string, string | number>;

export interface I18n {
  t(key: string, params?: Params): string;
  apply(root?: ParentNode): void;
  setLang(pref: LangCode | 'auto'): void;
  currentLang(): LangCode;
  langPref(): LangCode | 'auto';
  supported(): Record<LangCode, LangMeta>;
}

declare global {
  interface Window {
    i18n: I18n;
    // Tauri injects this synchronously (withGlobalTauri). Loosely typed — the
    // app only pokes a handful of plugin invoke paths off it.
    __TAURI__?: any;
  }
}

(function () {
  const LANGS: Record<LangCode, LangMeta> = {
    'en': { label: 'English' },
    'zh-Hans': { label: '简体中文' },
    'zh-Hant': { label: '繁體中文' },
  };

  const DICT: Record<LangCode, Record<string, string>> = {
    en: {
      'btn.download': 'Download',
      'ph.url': 'Paste a video URL…',
      'aria.cookies': 'Cookies',
      'aria.settings': 'Settings',
      'aria.selectMultiple': 'Select multiple',
      'aria.close': 'Close',
      'aria.play': 'Play',
      'aria.language': 'Language',
      'aria.theme': 'Theme',
      'aria.serverStatus': 'Server status',
      'status.up': 'Server online',
      'status.down': 'Server unreachable',
      'theme.system': 'System',
      'theme.light': 'Light',
      'theme.dark': 'Dark',
      'ph.search': 'Search…  failed  twitter  user:rick  title:"never gonna"  -title:live',
      'title.search': 'e621-style syntax: id: user:/uploader: title: platform:/site: status: — prefix a term with - to exclude. Bare words match title, uploader OR platform; a bare status word (queued/running/completed/failed) filters by status.',
      'empty': 'No items yet.',

      'sel.count0': 'Select items',
      'sel.countN': '{n} selected',
      'sel.download': 'Download',
      'sel.share': 'Share',
      'sel.unshare': 'Unshare',
      'sel.copy': 'Copy links',
      'sel.done': 'Done',

      'batchShare.title': 'Share selected',
      'batchShare.create': 'Create links',
      'batchShare.sub': '{n} item(s) will get a public link.',

      'share.title': 'Share',
      'share.duration': 'Link duration',
      'share.days7': '7 days',
      'share.days30': '30 days',
      'share.permanent': 'Permanent',
      'share.copy': 'Copy',
      'share.stop': 'Stop sharing',
      'share.create': 'Create link',
      'share.update': 'Update link',
      'share.cancelMsg': 'Cancel this share? The link stops working immediately for everyone.',
      'share.keep': 'Keep sharing',
      'share.cancelYes': 'Cancel share',

      'settings.title': 'Settings',
      'settings.serverUrl': 'Server URL',
      'settings.serverHint': 'Only needed in the app. Leave blank when opening Whale in a browser.',
      'ph.server': 'https://whale.example.com (blank = this site)',
      'settings.token': 'API token',
      'ph.token': 'Bearer token',
      'settings.tokenInvalid': 'Invalid token.',
      'settings.language': 'Language',
      'lang.auto': 'Auto (system)',
      'settings.archive': 'Seal / yt-dlp download archive',
      'settings.archiveHint': 'Every entry Whale has ever recorded, one <code>extractor id</code> per line (e.g. <code>youtube dQw4w9WgXcQ</code>). Edit freely — add lines to mark items as already downloaded, or delete lines to let them re-download — then Save.',
      'settings.archiveSave': 'Save archive',
      'ph.archive': 'youtube dQw4w9WgXcQ\ntwitter 1466...\nbilibili BV1...',
      'btn.save': 'Save',

      'cookies.title': 'Platform cookies',
      'cookies.hint': 'Log in on a site, export its cookies with a “Get cookies.txt” browser extension, then paste them here. Whale applies them automatically to every download from that platform (X cookies → all x.com / twitter.com links, etc.).',
      'ph.cookiePaste': 'Paste Netscape cookies.txt here…',
      'cookie.notSet': 'Not set',
      'cookie.active': 'Active · {size}',
      'cookie.disabled': 'Disabled · {size}',
      'cookie.disable': 'Disable',
      'cookie.enable': 'Enable',
      'cookie.delete': 'Delete',
      'cookie.login': 'Log in ↗',
      'cookie.replace': 'Replace cookies',
      'cookie.paste': 'Paste cookies',
      'cookie.save': 'Save',
      'cookie.cancel': 'Cancel',

      'status.queued': 'queued',
      'status.running': 'running',
      'status.completed': 'completed',
      'status.failed': 'failed',
      'status.duplicate': 'duplicate',

      'cloud.only': '☁ Cloud only',
      'aria.save': 'Save',
      'aria.share': 'Share',

      'expiry.never': 'Never expires',
      'expiry.expired': 'Expired',
      'expiry.in': 'Expires in {n} {unit}',
      'unit.day': 'day',
      'unit.days': 'days',
      'unit.hour': 'hour',
      'unit.hours': 'hours',

      'toast.loadHistoryFail': 'Failed to load history',
      'toast.network': 'Network error',
      'toast.setToken': 'Set your token first',
      'toast.setTokenSubmit': 'Set your token to submit',
      'toast.probeFail': 'Probe failed',
      'toast.submitFail': 'Submit failed',
      'toast.queuedN': 'Queued {n} item(s)',
      'toast.dupSuffix': ', {n} already downloaded',
      'toast.alreadyDownloaded': 'Already downloaded',
      'toast.queued': 'Queued',
      'toast.loadCookiesFail': 'Failed to load cookies',
      'toast.cookieUpdateFail': 'Cookie update failed',
      'toast.cookiesSaved': 'Cookies saved',
      'toast.cookiesRemoved': 'Cookies removed',
      'toast.pasteCookiesFirst': 'Paste cookies first',
      'toast.noChanges': 'No changes to save',
      'toast.saveFail': 'Save failed',
      'toast.removeFail': 'Failed to remove {key}',
      'toast.archiveSaved': 'Saved · +{add} −{rem}',
      'toast.loadArchiveFail': 'Failed to load archive',
      'toast.updateFail': 'Update failed',
      'toast.sharingStopped': 'Sharing stopped — now private',
      'toast.linkReady': 'Link ready — anyone with it can watch',
      'toast.linkCopied': 'Link copied',
      'toast.noDownloadable': 'No downloadable items selected',
      'toast.downloadingN': 'Downloading {n} item(s)',
      'toast.noShareable': 'No shareable items selected',
      'toast.shareFail': 'Share failed',
      'toast.sharedN': 'Shared {n} item(s) · links live {dur}',
      'dur.permanently': 'permanently',
      'dur.days': '{n} days',
      'toast.noShared': 'No shared items selected',
      'toast.stoppedSharingN': 'Stopped sharing {n} item(s)',
      'toast.noSharedLinks': 'No shared links yet — tap Share first',
      'toast.linksCopiedN': '{n} link(s) copied',
      'toast.streamFail': 'Could not resolve stream from source',
      'toast.pressBackExit': 'Press back again to exit',
    },

    'zh-Hans': {
      'btn.download': '下载',
      'ph.url': '粘贴视频链接…',
      'aria.cookies': 'Cookie',
      'aria.settings': '设置',
      'aria.selectMultiple': '多选',
      'aria.close': '关闭',
      'aria.play': '播放',
      'aria.language': '语言',
      'aria.theme': '主题',
      'aria.serverStatus': '服务器状态',
      'status.up': '服务器在线',
      'status.down': '服务器无法连接',
      'theme.system': '跟随系统',
      'theme.light': '浅色',
      'theme.dark': '深色',
      'ph.search': '搜索…  failed  twitter  user:rick  title:"never gonna"  -title:live',
      'title.search': 'e621 风格语法：id: user:/uploader: title: platform:/site: status: — 词语前加 - 表示排除。普通词匹配标题、上传者或平台；单独的状态词（queued/running/completed/failed）按状态过滤。',
      'empty': '暂无内容。',

      'sel.count0': '选择项目',
      'sel.countN': '已选 {n} 项',
      'sel.download': '下载',
      'sel.share': '分享',
      'sel.unshare': '取消分享',
      'sel.copy': '复制链接',
      'sel.done': '完成',

      'batchShare.title': '分享所选',
      'batchShare.create': '创建链接',
      'batchShare.sub': '将为 {n} 个项目创建公开链接。',

      'share.title': '分享',
      'share.duration': '链接有效期',
      'share.days7': '7 天',
      'share.days30': '30 天',
      'share.permanent': '永久',
      'share.copy': '复制',
      'share.stop': '停止分享',
      'share.create': '创建链接',
      'share.update': '更新链接',
      'share.cancelMsg': '要取消此分享吗？链接将立即对所有人失效。',
      'share.keep': '继续分享',
      'share.cancelYes': '取消分享',

      'settings.title': '设置',
      'settings.serverUrl': '服务器地址',
      'settings.serverHint': '仅在 App 中需要。在浏览器打开 Whale 时留空即可。',
      'ph.server': 'https://whale.example.com（留空 = 本站）',
      'settings.token': 'API 令牌',
      'ph.token': 'Bearer 令牌',
      'settings.tokenInvalid': '令牌无效。',
      'settings.language': '语言',
      'lang.auto': '自动（跟随系统）',
      'settings.archive': 'Seal / yt-dlp 下载存档',
      'settings.archiveHint': 'Whale 记录过的每一条，每行一个 <code>extractor id</code>（例如 <code>youtube dQw4w9WgXcQ</code>）。可自由编辑——添加行以标记为已下载，删除行以允许重新下载——然后保存。',
      'settings.archiveSave': '保存存档',
      'ph.archive': 'youtube dQw4w9WgXcQ\ntwitter 1466...\nbilibili BV1...',
      'btn.save': '保存',

      'cookies.title': '平台 Cookie',
      'cookies.hint': '在网站上登录，用“Get cookies.txt”浏览器扩展导出其 Cookie，然后粘贴到这里。Whale 会在该平台的每次下载中自动应用（X 的 Cookie → 所有 x.com / twitter.com 链接，依此类推）。',
      'ph.cookiePaste': '在此粘贴 Netscape 格式的 cookies.txt…',
      'cookie.notSet': '未设置',
      'cookie.active': '已启用 · {size}',
      'cookie.disabled': '已禁用 · {size}',
      'cookie.disable': '禁用',
      'cookie.enable': '启用',
      'cookie.delete': '删除',
      'cookie.login': '登录 ↗',
      'cookie.replace': '替换 Cookie',
      'cookie.paste': '粘贴 Cookie',
      'cookie.save': '保存',
      'cookie.cancel': '取消',

      'status.queued': '排队中',
      'status.running': '进行中',
      'status.completed': '已完成',
      'status.failed': '失败',
      'status.duplicate': '重复',

      'cloud.only': '☁ 仅云端',
      'aria.save': '保存',
      'aria.share': '分享',

      'expiry.never': '永不过期',
      'expiry.expired': '已过期',
      'expiry.in': '{n} {unit}后过期',
      'unit.day': '天',
      'unit.days': '天',
      'unit.hour': '小时',
      'unit.hours': '小时',

      'toast.loadHistoryFail': '加载历史失败',
      'toast.network': '网络错误',
      'toast.setToken': '请先设置令牌',
      'toast.setTokenSubmit': '设置令牌后才能提交',
      'toast.probeFail': '探测失败',
      'toast.submitFail': '提交失败',
      'toast.queuedN': '已加入队列 {n} 项',
      'toast.dupSuffix': '，{n} 项已下载过',
      'toast.alreadyDownloaded': '已下载过',
      'toast.queued': '已加入队列',
      'toast.loadCookiesFail': '加载 Cookie 失败',
      'toast.cookieUpdateFail': 'Cookie 更新失败',
      'toast.cookiesSaved': 'Cookie 已保存',
      'toast.cookiesRemoved': 'Cookie 已删除',
      'toast.pasteCookiesFirst': '请先粘贴 Cookie',
      'toast.noChanges': '没有可保存的更改',
      'toast.saveFail': '保存失败',
      'toast.removeFail': '删除失败：{key}',
      'toast.archiveSaved': '已保存 · +{add} −{rem}',
      'toast.loadArchiveFail': '加载存档失败',
      'toast.updateFail': '更新失败',
      'toast.sharingStopped': '已停止分享——现在为私有',
      'toast.linkReady': '链接已就绪——任何人凭链接均可观看',
      'toast.linkCopied': '链接已复制',
      'toast.noDownloadable': '所选项目中没有可下载的',
      'toast.downloadingN': '正在下载 {n} 项',
      'toast.noShareable': '所选项目中没有可分享的',
      'toast.shareFail': '分享失败',
      'toast.sharedN': '已分享 {n} 项 · 链接有效期 {dur}',
      'dur.permanently': '永久',
      'dur.days': '{n} 天',
      'toast.noShared': '所选项目中没有已分享的',
      'toast.stoppedSharingN': '已停止分享 {n} 项',
      'toast.noSharedLinks': '尚无分享链接——请先点分享',
      'toast.linksCopiedN': '已复制 {n} 个链接',
      'toast.streamFail': '无法从源站解析出播放地址',
      'toast.pressBackExit': '再按一次返回退出',
    },

    'zh-Hant': {
      'btn.download': '下載',
      'ph.url': '貼上影片連結…',
      'aria.cookies': 'Cookie',
      'aria.settings': '設定',
      'aria.selectMultiple': '多選',
      'aria.close': '關閉',
      'aria.play': '播放',
      'aria.language': '語言',
      'aria.theme': '主題',
      'aria.serverStatus': '伺服器狀態',
      'status.up': '伺服器在線',
      'status.down': '伺服器無法連線',
      'theme.system': '跟隨系統',
      'theme.light': '淺色',
      'theme.dark': '深色',
      'ph.search': '搜尋…  failed  twitter  user:rick  title:"never gonna"  -title:live',
      'title.search': 'e621 風格語法：id: user:/uploader: title: platform:/site: status: — 詞語前加 - 表示排除。一般詞會比對標題、上傳者或平台；單獨的狀態詞（queued/running/completed/failed）依狀態過濾。',
      'empty': '尚無內容。',

      'sel.count0': '選擇項目',
      'sel.countN': '已選 {n} 項',
      'sel.download': '下載',
      'sel.share': '分享',
      'sel.unshare': '取消分享',
      'sel.copy': '複製連結',
      'sel.done': '完成',

      'batchShare.title': '分享所選',
      'batchShare.create': '建立連結',
      'batchShare.sub': '將為 {n} 個項目建立公開連結。',

      'share.title': '分享',
      'share.duration': '連結有效期',
      'share.days7': '7 天',
      'share.days30': '30 天',
      'share.permanent': '永久',
      'share.copy': '複製',
      'share.stop': '停止分享',
      'share.create': '建立連結',
      'share.update': '更新連結',
      'share.cancelMsg': '要取消此分享嗎？連結將立即對所有人失效。',
      'share.keep': '繼續分享',
      'share.cancelYes': '取消分享',

      'settings.title': '設定',
      'settings.serverUrl': '伺服器位址',
      'settings.serverHint': '僅在 App 中需要。在瀏覽器開啟 Whale 時留空即可。',
      'ph.server': 'https://whale.example.com（留空 = 本站）',
      'settings.token': 'API 權杖',
      'ph.token': 'Bearer 權杖',
      'settings.tokenInvalid': '權杖無效。',
      'settings.language': '語言',
      'lang.auto': '自動（跟隨系統）',
      'settings.archive': 'Seal / yt-dlp 下載封存',
      'settings.archiveHint': 'Whale 記錄過的每一筆，每行一個 <code>extractor id</code>（例如 <code>youtube dQw4w9WgXcQ</code>）。可自由編輯——新增行以標記為已下載，刪除行以允許重新下載——然後儲存。',
      'settings.archiveSave': '儲存封存',
      'ph.archive': 'youtube dQw4w9WgXcQ\ntwitter 1466...\nbilibili BV1...',
      'btn.save': '儲存',

      'cookies.title': '平台 Cookie',
      'cookies.hint': '在網站上登入，用「Get cookies.txt」瀏覽器擴充功能匯出其 Cookie，然後貼到這裡。Whale 會在該平台的每次下載中自動套用（X 的 Cookie → 所有 x.com / twitter.com 連結，以此類推）。',
      'ph.cookiePaste': '在此貼上 Netscape 格式的 cookies.txt…',
      'cookie.notSet': '未設定',
      'cookie.active': '已啟用 · {size}',
      'cookie.disabled': '已停用 · {size}',
      'cookie.disable': '停用',
      'cookie.enable': '啟用',
      'cookie.delete': '刪除',
      'cookie.login': '登入 ↗',
      'cookie.replace': '替換 Cookie',
      'cookie.paste': '貼上 Cookie',
      'cookie.save': '儲存',
      'cookie.cancel': '取消',

      'status.queued': '排隊中',
      'status.running': '進行中',
      'status.completed': '已完成',
      'status.failed': '失敗',
      'status.duplicate': '重複',

      'cloud.only': '☁ 僅雲端',
      'aria.save': '儲存',
      'aria.share': '分享',

      'expiry.never': '永不過期',
      'expiry.expired': '已過期',
      'expiry.in': '{n} {unit}後過期',
      'unit.day': '天',
      'unit.days': '天',
      'unit.hour': '小時',
      'unit.hours': '小時',

      'toast.loadHistoryFail': '載入歷史失敗',
      'toast.network': '網路錯誤',
      'toast.setToken': '請先設定權杖',
      'toast.setTokenSubmit': '設定權杖後才能提交',
      'toast.probeFail': '探測失敗',
      'toast.submitFail': '提交失敗',
      'toast.queuedN': '已加入佇列 {n} 項',
      'toast.dupSuffix': '，{n} 項已下載過',
      'toast.alreadyDownloaded': '已下載過',
      'toast.queued': '已加入佇列',
      'toast.loadCookiesFail': '載入 Cookie 失敗',
      'toast.cookieUpdateFail': 'Cookie 更新失敗',
      'toast.cookiesSaved': 'Cookie 已儲存',
      'toast.cookiesRemoved': 'Cookie 已刪除',
      'toast.pasteCookiesFirst': '請先貼上 Cookie',
      'toast.noChanges': '沒有可儲存的變更',
      'toast.saveFail': '儲存失敗',
      'toast.removeFail': '刪除失敗：{key}',
      'toast.archiveSaved': '已儲存 · +{add} −{rem}',
      'toast.loadArchiveFail': '載入封存失敗',
      'toast.updateFail': '更新失敗',
      'toast.sharingStopped': '已停止分享——現在為私人',
      'toast.linkReady': '連結已就緒——任何人憑連結皆可觀看',
      'toast.linkCopied': '連結已複製',
      'toast.noDownloadable': '所選項目中沒有可下載的',
      'toast.downloadingN': '正在下載 {n} 項',
      'toast.noShareable': '所選項目中沒有可分享的',
      'toast.shareFail': '分享失敗',
      'toast.sharedN': '已分享 {n} 項 · 連結有效期 {dur}',
      'dur.permanently': '永久',
      'dur.days': '{n} 天',
      'toast.noShared': '所選項目中沒有已分享的',
      'toast.stoppedSharingN': '已停止分享 {n} 項',
      'toast.noSharedLinks': '尚無分享連結——請先點分享',
      'toast.linksCopiedN': '已複製 {n} 個連結',
      'toast.streamFail': '無法從來源站解析出播放位址',
      'toast.pressBackExit': '再按一次返回鍵離開',
    },
  };

  const STORE_KEY = 'whale_lang';

  // Map any BCP-47-ish tag to one of our supported locales, or null.
  function normalize(tag: string): LangCode | null {
    tag = (tag || '').toLowerCase();
    if (!tag) return null;
    if (tag.indexOf('zh') === 0) {
      // Traditional for the Hant script or the TW/HK/MO regions; else Simplified.
      if (/hant|tw|hk|mo/.test(tag)) return 'zh-Hant';
      return 'zh-Hans';
    }
    const base = tag.split('-')[0];
    return LANGS[base] ? base : null;
  }

  // Best supported locale from the browser/OS preference list.
  function detect(): LangCode {
    const list = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || 'en'];
    for (const tag of list) { const n = normalize(tag); if (n) return n; }
    return 'en';
  }

  let override = localStorage.getItem(STORE_KEY) || '';   // '' = follow system
  let current: LangCode = (override && LANGS[override]) ? override : detect();

  function t(key: string, params?: Params): string {
    const table = DICT[current] || DICT.en;
    let s = (table && table[key] != null) ? table[key]
          : (DICT.en[key] != null ? DICT.en[key] : key);
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
    return s;
  }

  // Translate a static subtree: [data-i18n] text, [data-i18n-html] markup, and
  // placeholder / title / aria-label variants.
  function apply(root?: ParentNode): void {
    const scope: ParentNode = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')!); });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html')!); });
    scope.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')!)); });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title')!)); });
    scope.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')!)); });
    document.documentElement.lang = current;
  }

  // Switch language. `pref` is a supported locale or 'auto' to follow the system.
  function setLang(pref: LangCode | 'auto'): void {
    if (!pref || pref === 'auto') { override = ''; localStorage.removeItem(STORE_KEY); }
    else { override = pref; localStorage.setItem(STORE_KEY, pref); }
    current = (override && LANGS[override]) ? override : detect();
    apply(document);
    document.dispatchEvent(new CustomEvent('i18n:changed'));
  }

  window.i18n = {
    t, apply, setLang,
    currentLang: () => current,
    langPref: () => (override || 'auto'),
    supported: () => LANGS,
  };
})();
