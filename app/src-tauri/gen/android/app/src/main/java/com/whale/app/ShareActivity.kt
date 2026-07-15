package com.whale.app

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * "Quick Download" share target (mirrors Seal's QuickDownloadActivity).
 *
 * Tapping Whale's "Quick Download" in another app's share sheet must NOT open
 * the full Whale UI: it forwards the shared link to the configured Whale backend
 * IN THE BACKGROUND and reports the result as a notification, then gets out of
 * the way. Whale downloads on a remote server, so "quick download" is just a
 * `POST /api/items` to that server — no local engine, no visible activity.
 *
 * Server base + token live in the WebView's localStorage, which native code
 * can't read. MainActivity's WebView mirrors them to
 * `<dataDir>/whale_share_creds.json` (via the `save_share_creds` Tauri command)
 * on launch and whenever they change; we read that here. If creds are missing
 * (app never opened/configured), we fall back to forwarding the intent into
 * MainActivity so first-run setup still works.
 *
 * Feedback is never silent: on success we post a notification; on ANY failure
 * (probe error, auth, unreachable) the notification is tappable and re-opens the
 * app with the shared URL prefilled, so the user sees the real, actionable error
 * toast (e.g. "add your X / Twitter cookies") instead of a share that vanished.
 */
class ShareActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    dumpIntent(intent)
    val url = extractUrl(extractSharedText(intent))
    if (url == null) {
      Log.w(TAG, "no URL extracted from intent — finishing silently")
      toast(applicationContext, "Whale · no link found in share")
      finish()
      return
    }
    Log.i(TAG, "extracted url=$url")

    val creds = readCreds()
    if (creds == null) {
      // Not configured yet: open the full app so the user can set token/server,
      // handing the link over the way the WebView drain path expects.
      Log.w(TAG, "no creds — forwarding into MainActivity")
      toast(applicationContext, "Whale · open the app to set server/token")
      startActivity(openAppWithUrl(this, url))
      finish()
      return
    }
    Log.i(TAG, "creds ok base=${creds.first}")

    // Fire the download in the background, notify the result, and exit
    // immediately with no visible UI — this is the "Quick Download" behaviour.
    val appCtx = applicationContext
    val (base, token) = creds
    // Headless quick download is otherwise invisible (a background notification is
    // easy to miss). Show an immediate on-screen Toast over the sharing app so the
    // user always sees the share was received and is being sent.
    toast(appCtx, "Whale · sending…")
    Thread { submitAndNotify(appCtx, base, token, url) }.start()
    finish()
  }

  private fun readCreds(): Pair<String, String>? {
    return try {
      val f = File(dataDir, "whale_share_creds.json")
      if (!f.exists()) return null
      val o = JSONObject(f.readText())
      val base = o.optString("base").trimEnd('/')
      val token = o.optString("token")
      if (base.isEmpty() || token.isEmpty()) null else Pair(base, token)
    } catch (e: Exception) {
      null
    }
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
    private const val TAG = "WhaleShare"
    private const val CHANNEL_ID = "quick_download"
    // Notification-id base for per-item progress notifications, keyed by item id
    // so each download owns one updatable notification.
    private const val NOTIF_BASE = 200000

    /** An intent that opens MainActivity (the WebView) with `url` prefilled so
     *  the frontend's drain path re-submits it and shows the real error toast. */
    private fun openAppWithUrl(ctx: Context, url: String): Intent =
      Intent(ctx, MainActivity::class.java).apply {
        action = Intent.ACTION_SEND
        type = "text/plain"
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        putExtra(Intent.EXTRA_TEXT, url)
      }

    private fun submitAndNotify(ctx: Context, base: String, token: String, url: String) {
      var title = "Whale"
      var body: String
      var ok = false
      var itemId = -1
      var duplicate = false
      var blur = false
      try {
        val conn = (URL("$base/api/items").openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"
          connectTimeout = 15000
          readTimeout = 30000
          doOutput = true
          setRequestProperty("Content-Type", "application/json")
          setRequestProperty("Authorization", "Bearer $token")
        }
        val payload = JSONObject().put("url", url).put("options", JSONObject()).toString()
        conn.outputStream.use { it.write(payload.toByteArray()) }
        Log.i(TAG, "POST $base/api/items payload=$payload")
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val respText = stream?.bufferedReader()?.use { it.readText() } ?: ""
        Log.i(TAG, "response code=$code body=${respText.take(300)}")
        val resp = try { JSONObject(respText) } catch (e: Exception) { JSONObject() }
        body = when {
          code in 200..299 -> {
            ok = true
            val item = resp.optJSONObject("item")
            itemId = item?.optInt("id", -1) ?: -1
            title = item?.optString("title")?.takeIf { it.isNotEmpty() } ?: "Link"
            duplicate = resp.optBoolean("duplicate")
            // A privacy-blurred site's real title must never land in a persistent
            // notification the user has to clear by hand — mask it with the id.
            blur = item?.optBoolean("blur", false) ?: false
            if (duplicate) "Already downloaded" else "Download queued ✓"
          }
          code == 422 || resp.optString("error") == "probe_failed" ->
            resp.optString("message").ifEmpty { "Couldn't read that link" }
          code == 401 -> "Auth failed — open Whale and set your token"
          else -> "Submit failed (HTTP $code)"
        }
        conn.disconnect()
      } catch (e: Exception) {
        Log.e(TAG, "POST failed", e)
        body = "Can't reach the Whale server"
      }
      // Visible result over the sharing app: success/duplicate/error all surface
      // as a Toast so the quick channel is never silent.
      toast(ctx, "Whale · $body")
      // One notification per item, keyed by a stable id so progress updates
      // REPLACE it in place instead of stacking (one slot per item, never two).
      val notifId = if (itemId >= 0) NOTIF_BASE + itemId else (System.currentTimeMillis() % 100000).toInt()
      val active = ok && !duplicate && itemId >= 0
      if (active) {
        // Deliberately NO "queued" notification here: the Toast above already
        // acknowledged the queue, and echoing it into the persistent channel was
        // the redundant buzz. The system notification first appears once the
        // download is actually running and then updates that SAME notification
        // through to completion (see pollProgress) — silent (onlyAlertOnce).
        pollProgress(ctx, base, token, itemId, notifId, title, blur)
      } else if (!ok) {
        // A real failure still needs a tappable notification (the Toast is easy to
        // miss) so the user can reopen the app and retry with the actual error.
        postNotif(ctx, notifId, notifTitle(title, blur, itemId), body, url, ongoing = false, indeterminate = false)
      }
      // success + duplicate: Toast only — it's already downloaded, nothing to track.
    }

    /** Notification title, masking a privacy-blurred site's real name (which would
     *  otherwise sit in a persistent notification the user must clear by hand). */
    private fun notifTitle(title: String, blur: Boolean, itemId: Int): String =
      if (blur) (if (itemId >= 0) "Item #$itemId" else "Download") else title

    /** Poll the server for this item's status and update its notification in
     *  place until it finishes. Silent (no new sound) thanks to onlyAlertOnce.
     *  Bounded (~10 min) so a stuck download can't spin forever; best-effort —
     *  the process may be reclaimed while backgrounded, which is fine. */
    private fun pollProgress(ctx: Context, base: String, token: String, itemId: Int, notifId: Int, titleIn: String, blurIn: Boolean) {
      var title = titleIn
      var blur = blurIn
      var tries = 0
      while (tries < 200) {
        tries++
        try { Thread.sleep(3000) } catch (e: InterruptedException) { return }
        try {
          val conn = (URL("$base/api/items/$itemId").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15000
            readTimeout = 20000
            setRequestProperty("Authorization", "Bearer $token")
          }
          val code = conn.responseCode
          if (code !in 200..299) { conn.disconnect(); continue }
          val txt = conn.inputStream.bufferedReader().use { it.readText() }
          conn.disconnect()
          val item = JSONObject(txt)
          item.optString("title").takeIf { it.isNotEmpty() }?.let { title = it }
          blur = item.optBoolean("blur", blur) // may flip if the site setting changed
          val shown = notifTitle(title, blur, itemId)
          when (item.optString("status")) {
            "completed" -> { postNotif(ctx, notifId, shown, "Download complete ✓", null, ongoing = false, indeterminate = false); return }
            "failed" -> {
              val msg = item.optString("error").ifEmpty { "Download failed" }
              postNotif(ctx, notifId, shown, msg, null, ongoing = false, indeterminate = false)
              return
            }
            "running" -> postNotif(ctx, notifId, shown, "Downloading…", null, ongoing = true, indeterminate = true)
            // Still queued: keep polling but post NOTHING — the Toast already
            // acknowledged the queue; a persistent "Queued…" here was the redundant buzz.
            "queued" -> { /* no notification while queued */ }
            else -> return // deleted/unknown — stop quietly
          }
        } catch (e: Exception) {
          // Transient network hiccup; keep trying within the bound.
        }
      }
    }

    /** Show a Toast from any thread (Toasts must be posted on the main looper). */
    private fun toast(ctx: Context, msg: String) {
      Handler(Looper.getMainLooper()).post {
        Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show()
      }
    }

    /** Post/replace a notification by a stable id. `ongoing` keeps it pinned while
     *  the download runs; `indeterminate` shows a moving progress bar. Always
     *  `onlyAlertOnce` so replacing it for progress never plays a new sound — the
     *  fix for the "queued, then repeated buzzing" complaint. */
    private fun postNotif(
      ctx: Context,
      notifId: Int,
      title: String,
      body: String,
      retryUrl: String?,
      ongoing: Boolean,
      indeterminate: Boolean,
    ) {
      try {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val builder: Notification.Builder
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Quick Download", NotificationManager.IMPORTANCE_DEFAULT)
          )
          builder = Notification.Builder(ctx, CHANNEL_ID)
        } else {
          @Suppress("DEPRECATION")
          builder = Notification.Builder(ctx)
        }
        builder
          .setSmallIcon(R.drawable.ic_notification)
          .setContentTitle(title)
          .setContentText(body)
          .setStyle(Notification.BigTextStyle().bigText(body))
          .setOnlyAlertOnce(true)
          .setOngoing(ongoing)
          .setAutoCancel(!ongoing)
        if (indeterminate) builder.setProgress(0, 0, true)
        // On failure, tapping the notification reopens the app with the link so
        // the user can read the full error / retry with cookies.
        if (retryUrl != null) {
          val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
          val pi = PendingIntent.getActivity(
            ctx, retryUrl.hashCode(), openAppWithUrl(ctx, retryUrl), flags
          )
          builder.setContentIntent(pi)
        }
        nm.notify(notifId, builder.build())
      } catch (e: Exception) {
        // Notifications are best-effort; the download was still submitted.
      }
    }
  }
}
