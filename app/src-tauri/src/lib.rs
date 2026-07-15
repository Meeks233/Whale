//! Whale app shell. The UI is the exact same `web/` frontend the server serves;
//! this Tauri wrapper just hosts it in a native WebView (Android/desktop) and,
//! on mobile, bridges the Android share intent into a URL submission.

use tauri::Manager;

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

/// Re-arm the Android launch-time permission prompt from the in-app Settings, for
/// a user who previously chose "Don't ask again" but changed their mind. Drops a
/// sentinel file `MainActivity` picks up in `onResume` (same app-data-dir bridge
/// as `save_share_creds`); it clears the opt-out and re-shows the prompt. No-op
/// on desktop, where these Android runtime permissions don't apply.
#[tauri::command]
fn reset_permission_prompt(app: tauri::AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("whale_perm_request"), b"1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![save_share_creds, reset_permission_prompt]);

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
