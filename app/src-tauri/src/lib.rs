//! Orca app shell. The UI is the exact same `web/` frontend the server serves;
//! this Tauri wrapper just hosts it in a native WebView (Android/desktop) and,
//! on mobile, bridges the Android share intent into a URL submission.

use tauri::Manager;

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct AndroidPermissionStatus {
    notifications: bool,
    background: bool,
    /// Whether the app may write Downloads/ ("All files access" on API 30+).
    #[serde(default)]
    storage: bool,
    /// Whether saves go to the hidden `Downloads/.Orca` instead of `Downloads/Orca`.
    #[serde(default, rename = "hideDownloads")]
    hide_downloads: bool,
    /// Files relocated by the last `set_hide_downloads` call; absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    moved: Option<u32>,
}

#[cfg(target_os = "android")]
struct AndroidPermissions<R: tauri::Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
fn android_permissions_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("orca-permissions")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.orca.app", "PermissionsPlugin")?;
            app.manage(AndroidPermissions(handle));
            Ok(())
        })
        .build()
}

/// Mirror the server base URL + token from the WebView's localStorage into a
/// file the native `ShareActivity` can read (`<app_data_dir>/orca_share_creds.json`).
///
/// The "Quick Download" share target submits to the backend IN THE BACKGROUND
/// without opening the WebView, so it can't read localStorage. The frontend
/// calls this whenever the creds change (and on launch) so a headless share
/// always has fresh creds.
#[tauri::command]
fn save_share_creds(app: tauri::AppHandle, base: String, token: String) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let body = serde_json::json!({ "base": base, "token": token }).to_string();
        let _ = std::fs::write(dir.join("orca_share_creds.json"), body);
    }
}

#[tauri::command]
fn android_permission_status<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<AndroidPermissionStatus, String> {
    #[cfg(target_os = "android")]
    {
        return _app
            .state::<AndroidPermissions<R>>()
            .0
            .run_mobile_plugin("status", ())
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    Err("Android permissions are unavailable on this platform".into())
}

#[tauri::command]
fn request_background_permission<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<AndroidPermissionStatus, String> {
    #[cfg(target_os = "android")]
    {
        return _app
            .state::<AndroidPermissions<R>>()
            .0
            .run_mobile_plugin("requestBackground", ())
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    Err("Android permissions are unavailable on this platform".into())
}

#[tauri::command]
fn request_notification_permission<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<AndroidPermissionStatus, String> {
    #[cfg(target_os = "android")]
    {
        return _app
            .state::<AndroidPermissions<R>>()
            .0
            .run_mobile_plugin("requestNotifications", ())
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    Err("Android permissions are unavailable on this platform".into())
}

/// Send the user to the OS screen that grants access to shared storage, so
/// "save to device" can write Downloads/Orca. On API 30+ this is a Settings
/// screen rather than a dialog, so the returned status is usually still
/// `storage: false` — the frontend re-reads it on resume.
#[tauri::command]
fn request_storage_permission<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<AndroidPermissionStatus, String> {
    #[cfg(target_os = "android")]
    {
        return _app
            .state::<AndroidPermissions<R>>()
            .0
            .run_mobile_plugin("requestStorage", ())
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    Err("Android permissions are unavailable on this platform".into())
}

/// Save a finished item's file to Downloads/Orca. `url` is the same tokenised
/// `/file?download=1` link the browser would follow — an Android WebView just
/// ignores `<a download>`, which is why this exists.
#[tauri::command]
fn save_media<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    _url: String,
    _name: String,
    _slug: String,
    _height: i64,
) -> Result<AndroidPermissionStatus, String> {
    #[cfg(target_os = "android")]
    {
        return _app
            .state::<AndroidPermissions<R>>()
            .0
            .run_mobile_plugin(
                "saveMedia",
                serde_json::json!({
                    "url": _url, "name": _name, "slug": _slug, "height": _height,
                }),
            )
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    Err("Saving to device is only available in the Android app".into())
}

/// Where an item's locally-saved file lives, so the player can play it off this
/// device instead of streaming it back from the server. `path` is empty when
/// there is no local copy (or it has since been deleted).
#[derive(Debug, Default, serde::Deserialize, serde::Serialize)]
struct LocalFile {
    #[serde(default)]
    path: String,
    #[serde(default)]
    height: i64,
    /// Loopback URL the WebView can actually play (see LocalMediaServer.kt —
    /// Android's media stack ignores the asset protocol, so a real HTTP origin
    /// is required). Empty when there is no local copy.
    #[serde(default)]
    url: String,
}

/// One item to look up, carrying the server's fingerprint for it so the native
/// side can also recognise a copy it never recorded — see `MediaSaver.adopt`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct LocalQuery {
    slug: String,
    /// Name the server serves the file under; empty when it has no local file.
    #[serde(default)]
    name: String,
    /// Exact byte size of that file. 0 when unknown — no adoption is attempted.
    #[serde(default)]
    size: i64,
    #[serde(default)]
    height: i64,
}

/// The Android plugin bridge resolves a JSON *object*, never a bare array, so
/// the batch answer rides in a one-field envelope. Same order as the request.
#[cfg(target_os = "android")]
#[derive(Debug, Default, serde::Deserialize, serde::Serialize)]
struct LocalFiles {
    #[serde(default)]
    files: Vec<LocalFile>,
}

/// Resolve a whole page of items at once. Batched deliberately: the folder is
/// listed once per call rather than once per item, so recognising ten cards
/// costs one directory read instead of ten.
#[tauri::command]
fn local_files<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    _items: Vec<LocalQuery>,
) -> Result<Vec<LocalFile>, String> {
    #[cfg(target_os = "android")]
    {
        return _app
            .state::<AndroidPermissions<R>>()
            .0
            .run_mobile_plugin::<LocalFiles>("localFiles", serde_json::json!({ "items": _items }))
            .map(|r| r.files)
            .map_err(|e| e.to_string());
    }
    // Desktop has no local-save path at all, so "no local copy" is the honest
    // answer — and lets the caller use one code path on every platform.
    #[cfg(not(target_os = "android"))]
    Ok(_items.iter().map(|_| LocalFile::default()).collect())
}

/// Move saved downloads between `Downloads/Orca` and the hidden
/// `Downloads/.Orca`, and pin where future saves land.
#[tauri::command]
fn set_hide_downloads<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    _hidden: bool,
) -> Result<AndroidPermissionStatus, String> {
    #[cfg(target_os = "android")]
    {
        return _app
            .state::<AndroidPermissions<R>>()
            .0
            .run_mobile_plugin("setHideDownloads", serde_json::json!({ "hidden": _hidden }))
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    Err("Saving to device is only available in the Android app".into())
}

/// Hand a download submitted from inside the app to the Android foreground
/// service that owns download notifications, so an in-app download notifies the
/// same way a shared link does. No-op off Android.
#[tauri::command]
fn track_download<R: tauri::Runtime>(_app: tauri::AppHandle<R>, _slug: String) {
    #[cfg(target_os = "android")]
    {
        let _ = _app
            .state::<AndroidPermissions<R>>()
            .0
            .run_mobile_plugin::<serde_json::Value>(
                "trackDownload",
                serde_json::json!({ "slug": _slug }),
            );
    }
}

#[derive(Debug, Default, serde::Deserialize, serde::Serialize)]
struct PendingDeeplink {
    /// Absent whenever no notification tap is pending.
    #[serde(default)]
    slug: Option<String>,
}

/// Drain the item slug stashed by a download-notification tap, so the frontend
/// can scroll to that row. Returns `None` when nothing is pending.
#[tauri::command]
fn take_pending_deeplink<R: tauri::Runtime>(_app: tauri::AppHandle<R>) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        return _app
            .state::<AndroidPermissions<R>>()
            .0
            .run_mobile_plugin::<PendingDeeplink>("takePendingDeeplink", ())
            .ok()
            .and_then(|d| d.slug);
    }
    #[cfg(not(target_os = "android"))]
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_share_creds,
            android_permission_status,
            request_notification_permission,
            request_background_permission,
            request_storage_permission,
            save_media,
            local_files,
            set_hide_downloads,
            track_download,
            take_pending_deeplink
        ]);

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(android_permissions_plugin());
    }

    // Android/iOS: register the share-target plugin so shared URLs land in a
    // queue the frontend drains on launch/focus (see web/app.js).
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_mobile_sharetarget::init());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running Orca app");
}
