//! Whale app shell. The UI is the exact same `web/` frontend the server serves;
//! this Tauri wrapper just hosts it in a native WebView (Android/desktop) and,
//! on mobile, will bridge the Android share intent into a URL submission.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

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
