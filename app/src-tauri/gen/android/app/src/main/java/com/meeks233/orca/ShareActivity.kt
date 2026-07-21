package com.meeks233.orca

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log

/**
 * "Quick Download" share target (mirrors Seal's QuickDownloadActivity).
 *
 * Tapping Orca's "Quick Download" in another app's share sheet must NOT open
 * the full Orca UI: it forwards the shared link to the configured Orca backend
 * IN THE BACKGROUND and reports the result as a notification, then gets out of
 * the way. Orca downloads on a remote server, so "quick download" is just a
 * `POST /api/items` to that server — no local engine, no visible activity.
 *
 * This activity only parses the intent and hands the URL to [DownloadService];
 * the submit + progress notification live there. That split is deliberate: the
 * service must be started while this activity is still in the foreground
 * (Android 12+ forbids background foreground-service starts), and the work must
 * outlive `finish()` — a bare thread here was getting killed with the process,
 * which is why progress notifications used to freeze and never complete.
 *
 * Server base + token live in the WebView's localStorage, which native code
 * can't read. MainActivity's WebView mirrors them to
 * `<dataDir>/orca_share_creds.json` (via the `save_share_creds` Tauri command)
 * on launch and whenever they change; we read that here. If creds are missing
 * (app never opened/configured), we fall back to forwarding the intent into
 * MainActivity so first-run setup still works.
 */
class ShareActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    dumpIntent(intent)
    val url = extractUrl(extractSharedText(intent))
    if (url == null) {
      Log.w(TAG, "no URL extracted from intent — finishing silently")
      DownloadService.toast(applicationContext, "Orca · no link found in share")
      finish()
      return
    }
    Log.i(TAG, "extracted url=$url")

    if (OrcaApi.readCreds(this) == null) {
      // Not configured yet: open the full app so the user can set token/server,
      // handing the link over the way the WebView drain path expects.
      Log.w(TAG, "no creds — forwarding into MainActivity")
      DownloadService.toast(applicationContext, "Orca · open the app to set server/token")
      startActivity(DownloadService.openAppWithUrlIntent(this, url))
      finish()
      return
    }

    // Headless quick download is otherwise invisible (a background notification is
    // easy to miss). Show an immediate on-screen Toast over the sharing app so the
    // user always sees the share was received and is being sent.
    DownloadService.toast(applicationContext, "Orca · sending…")
    // Started from onCreate while we are still foreground — see the class note.
    DownloadService.submit(this, url)
    finish()
  }

  /** Pull the URL out of either a SEND (EXTRA_TEXT) or a VIEW (data URI) intent. */
  private fun extractSharedText(incoming: Intent?): String? {
    if (incoming == null) return null
    return when (incoming.action) {
      Intent.ACTION_SEND -> incoming.getStringExtra(Intent.EXTRA_TEXT)
      Intent.ACTION_VIEW -> incoming.dataString
      else -> null
    }
  }

  /** First http(s) URL out of arbitrary shared text ("Watch this https://…"). */
  private fun extractUrl(text: String?): String? {
    if (text == null) return null
    val m = Regex("https?://\\S+").find(text)
    return m?.value ?: text.trim().ifEmpty { null }
  }

  /** Diagnostic dump of the raw incoming share intent — action, type, data URI,
   *  every string extra and any ClipData items. Lets us see EXACTLY what the X
   *  app delivers when a real share "silently" does nothing. */
  // Bundle.get(String) is deprecated with no generic replacement; a diagnostic
  // dump legitimately wants the untyped value, so silence the warning here.
  @Suppress("DEPRECATION")
  private fun dumpIntent(i: Intent?) {
    if (i == null) { Log.w(TAG, "intent is null"); return }
    Log.i(TAG, "intent action=${i.action} type=${i.type} data=${i.dataString}")
    val ex = i.extras
    if (ex != null) for (k in ex.keySet()) {
      Log.i(TAG, "  extra[$k]=${ex.get(k)}")
    }
    val cd = i.clipData
    if (cd != null) for (n in 0 until cd.itemCount) {
      Log.i(TAG, "  clip[$n] text=${cd.getItemAt(n).text} uri=${cd.getItemAt(n).uri}")
    }
  }

  companion object {
    private const val TAG = "OrcaShare"
  }
}
