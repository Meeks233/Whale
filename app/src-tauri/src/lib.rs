//! Whale app shell. The UI is the exact same `web/` frontend the server serves;
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
    tauri::plugin::Builder::new("whale-permissions")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.whale.app", "PermissionsPlugin")?;
            app.manage(AndroidPermissions(handle));
            Ok(())
        })
        .build()
}

/// Mirror the server base URL + token from the WebView's localStorage into a
/// file the native `ShareActivity` can read (`<app_data_dir>/whale_share_creds.json`).
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
        let _ = std::fs::write(dir.join("whale_share_creds.json"), body);
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
            request_background_permission
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
        .expect("error while running Whale app");
}
