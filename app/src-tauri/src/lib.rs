//! Orca app shell. The UI is the exact same `web/` frontend the server serves;
//! this Tauri wrapper just hosts it in a native WebView (Android/desktop) and,
//! on mobile, bridges the Android share intent into a URL submission.

use tauri::Manager;

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct AndroidPermissionStatus {
    notifications: bool,
    background: bool,
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
        .invoke_handler(tauri::generate_handler![
            save_share_creds,
            android_permission_status,
            request_notification_permission,
            request_background_permission,
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
