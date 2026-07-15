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
import android.util.Base64
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

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
    // Notification-id base for per-item progress notifications. The private API
    // slug is hashed into Android's integer notification namespace.
    private const val NOTIF_BASE = 200000

    private data class E2eeCredential(val keyId: String, val key: SecretKeySpec)

    private fun sha256(bytes: ByteArray): ByteArray =
      MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun e2eeCredential(token: String): E2eeCredential {
      val authHash = sha256(token.toByteArray(Charsets.UTF_8))
      val keyId = sha256("whale-e2ee-kid-v1\u0000".toByteArray() + authHash)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
      val key = sha256("whale-e2ee-key-v1\u0000".toByteArray() + authHash)
      return E2eeCredential(keyId, SecretKeySpec(key, "AES"))
    }

    private fun seal(credential: E2eeCredential, plaintext: ByteArray, aad: String): String {
      val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, credential.key, GCMParameterSpec(128, nonce))
      cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
      return JSONObject()
        .put("v", 1)
        .put("n", Base64.encodeToString(nonce, Base64.NO_WRAP))
        .put("c", Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP))
        .toString()
    }

    private fun open(credential: E2eeCredential, envelope: String, aad: String): String {
      val parsed = JSONObject(envelope)
      require(parsed.optInt("v") == 1) { "invalid encrypted response" }
      val nonce = Base64.decode(parsed.getString("n"), Base64.DEFAULT)
      val ciphertext = Base64.decode(parsed.getString("c"), Base64.DEFAULT)
      require(nonce.size == 12 && ciphertext.size >= 16) { "invalid encrypted response" }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, credential.key, GCMParameterSpec(128, nonce))
      cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
      return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    }

    private fun configureE2ee(conn: HttpURLConnection, credential: E2eeCredential, hasBody: Boolean) {
      conn.setRequestProperty("X-Whale-E2EE", "1")
      conn.setRequestProperty("X-Whale-Key-Id", credential.keyId)
      if (hasBody) {
        conn.setRequestProperty("X-Whale-Encrypted-Body", "1")
        conn.setRequestProperty("Content-Type", "text/plain")
      }
    }

    private fun readResponse(conn: HttpURLConnection, credential: E2eeCredential, path: String): Pair<Int, String> {
      val code = conn.responseCode
      val stream = if (code in 200..299) conn.inputStream else conn.errorStream
      val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
      val plaintext = if (conn.getHeaderField("X-Whale-E2EE") == "1") {
        open(credential, body, "$code\n$path")
      } else body
      return Pair(code, plaintext)
    }

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
      var itemSlug = ""
      var videoId = ""
      var duplicate = false
      var blur = false
      try {
        val path = "/api/items"
        val credential = e2eeCredential(token)
        val conn = (URL("$base/api/items").openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"
          connectTimeout = 15000
          readTimeout = 30000
          doOutput = true
          configureE2ee(this, credential, true)
        }
        val payload = JSONObject().put("url", url).put("options", JSONObject()).toString()
        conn.outputStream.use { it.write(seal(credential, payload.toByteArray(), "POST\n$path").toByteArray()) }
        Log.i(TAG, "POST $base/api/items payload=$payload")
        val (code, respText) = readResponse(conn, credential, path)
        Log.i(TAG, "response code=$code body=${respText.take(300)}")
        val resp = try { JSONObject(respText) } catch (e: Exception) { JSONObject() }
        body = when {
          code in 200..299 -> {
            ok = true
            val item = resp.optJSONObject("item")
            itemSlug = item?.optString("slug") ?: ""
            videoId = item?.optString("video_id") ?: ""
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
      val notifId = if (itemSlug.isNotEmpty()) NOTIF_BASE + (itemSlug.hashCode() and 0x0fffffff) else (System.currentTimeMillis() % 100000).toInt()
      val active = ok && !duplicate && itemSlug.isNotEmpty()
      if (active) {
        // Deliberately NO "queued" notification here: the Toast above already
        // acknowledged the queue, and echoing it into the persistent channel was
        // the redundant buzz. The system notification first appears once the
        // download is actually running and then updates that SAME notification
        // through to completion (see pollProgress) — silent (onlyAlertOnce).
        pollProgress(ctx, base, token, itemSlug, notifId, title, videoId, blur)
      } else if (!ok) {
        // A real failure still needs a tappable notification (the Toast is easy to
        // miss) so the user can reopen the app and retry with the actual error.
        postNotif(ctx, notifId, notifTitle(title, blur, videoId), body, url, ongoing = false, indeterminate = false)
      }
      // success + duplicate: Toast only — it's already downloaded, nothing to track.
    }

    /** Notification title, masking a privacy-blurred site's real name (which would
     *  otherwise sit in a persistent notification the user must clear by hand).
     *  Masks with the source's own video id (tweet / youtube id) — meaningful yet
     *  title-free — falling back to the internal item id only when it's unknown. */
    private fun notifTitle(title: String, blur: Boolean, videoId: String): String =
      if (blur) (if (videoId.isNotEmpty()) "Video $videoId" else "Download") else title

    /** Poll the server for this item's status and update its notification in
     *  place until it finishes. Silent (no new sound) thanks to onlyAlertOnce.
     *  Bounded (~10 min) so a stuck download can't spin forever; best-effort —
     *  the process may be reclaimed while backgrounded, which is fine. */
    private fun pollProgress(ctx: Context, base: String, token: String, itemSlug: String, notifId: Int, titleIn: String, videoIdIn: String, blurIn: Boolean) {
      var title = titleIn
      var videoId = videoIdIn
      var blur = blurIn
      var tries = 0
      while (tries < 200) {
        tries++
        try { Thread.sleep(3000) } catch (e: InterruptedException) { return }
        try {
          val path = "/api/items/$itemSlug"
          val credential = e2eeCredential(token)
          val conn = (URL("$base/api/items/$itemSlug").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15000
            readTimeout = 20000
            configureE2ee(this, credential, false)
          }
          val (code, txt) = readResponse(conn, credential, path)
          // The item is gone (deleted while downloading → 404): clear our ongoing
          // notification so it can't linger as a ghost the user must swipe away.
          if (code == 404) { conn.disconnect(); cancelNotif(ctx, notifId); return }
          if (code !in 200..299) { conn.disconnect(); continue }
          conn.disconnect()
          val item = JSONObject(txt)
          item.optString("title").takeIf { it.isNotEmpty() }?.let { title = it }
          item.optString("video_id").takeIf { it.isNotEmpty() }?.let { videoId = it }
          blur = item.optBoolean("blur", blur) // may flip if the site setting changed
          val shown = notifTitle(title, blur, videoId)
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
            // Deleted / unknown status: drop any ongoing notification so it never
            // sticks around as a ghost, then stop.
            else -> { cancelNotif(ctx, notifId); return }
          }
        } catch (e: Exception) {
          // Transient network hiccup; keep trying within the bound.
        }
      }
    }

    /** Remove a notification by id (best-effort) — used to clear an ongoing
     *  progress notification whose download vanished, preventing ghost entries. */
    private fun cancelNotif(ctx: Context, notifId: Int) {
      try {
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notifId)
      } catch (e: Exception) { /* best-effort */ }
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
