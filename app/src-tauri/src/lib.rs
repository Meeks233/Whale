//! Whale app shell. The UI is the exact same `web/` frontend the server serves;
//! this Tauri wrapper just hosts it in a native WebView (Android/desktop) and,
//! on mobile, will bridge the Android share intent into a URL submission.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Whale app");
}
