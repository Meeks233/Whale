package com.orca.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.widget.Toast
import androidx.core.app.ServiceCompat
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Foreground service that owns every download-progress notification.
 *
 * Why a service: progress notifications used to be driven from two places, and
 * both were unreliable.
 *  - ShareActivity spawned a bare `Thread` and then `finish()`ed. With no live
 *    component the process became "empty" and Android reclaimed it, so the
 *    notification usually froze mid-download and never reached "complete".
 *  - The WebView also posted from the SSE stream, but only while the app is open
 *    — exactly when a notification matters least. Worse, both wrote the same
 *    notification id, so they overwrote each other's text.
 *
 * A foreground service is the standard Android answer: it keeps the process
 * alive for the duration of the work and makes ONE owner responsible for the
 * notification. The WebView now only hands slugs here (`track_download`).
 *
 * Progress data comes from `GET /api/items/:slug`, whose `progress` object the
 * backend populates from the live SSE tick cache (see src/queue.rs). Polling
 * (rather than holding the SSE stream) is deliberate: it survives the process
 * being killed and restarted, and a download is a minute-scale operation.
 */
class DownloadService : Service() {
  /** Slugs currently being tracked → the last notification text we posted. */
  private val tracked = ConcurrentHashMap<String, String>()

  /** In-flight submits. Keeps the service alive between "share received" and
   *  "server returned a slug to track", which would otherwise look idle. */
  private val submitting = AtomicInteger(0)

  @Volatile private var poller: Thread? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Android kills the process with ANR if startForeground() is not called
    // within ~5s of startForegroundService(), so this comes first.
    startForegroundSummary()

    val slug = intent?.getStringExtra(EXTRA_SLUG)?.takeIf { it.isNotEmpty() }
    if (slug != null) {
      tracked.putIfAbsent(slug, "")
      Log.i(TAG, "tracking $slug (${tracked.size} active)")
      startPolling()
    }

    // A shared link: submit it here rather than in ShareActivity, so the POST
    // outlives the share sheet closing.
    val url = intent?.getStringExtra(EXTRA_URL)?.takeIf { it.isNotEmpty() }
    if (url != null) {
      submitting.incrementAndGet()
      Thread { submitAndTrack(url) }.start()
    }

    if (tracked.isEmpty() && submitting.get() == 0) stopSelf()
    // Re-delivering a stale intent would resurrect finished downloads; the app
    // re-tracks anything still running on next launch.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    poller?.interrupt()
    poller = null
    // Explicitly drop ONLY the foreground summary. Per-item notifications —
    // including the "Download complete" one posted moments earlier — are not
    // tied to the service lifecycle and must outlive it.
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun startPolling() {
    if (poller?.isAlive == true) return
    poller = Thread { pollLoop() }.also { it.start() }
  }

  /**
   * Poll every tracked item until it reaches a terminal state. Bounded per item
   * by [MAX_TRIES] so a stuck download cannot pin the service forever.
   */
  private fun pollLoop() {
    val tries = HashMap<String, Int>()
    // Keep looping while a submit is still in flight: it is about to hand us a
    // slug to track, and exiting here would stop the service out from under it.
    while (tracked.isNotEmpty() || submitting.get() > 0) {
      val creds = OrcaApi.readCreds(applicationContext)
      if (creds == null) {
        Log.w(TAG, "no creds — stopping")
        break
      }
      val credential = OrcaApi.credential(creds.token)
      for (slug in tracked.keys.toList()) {
        val n = (tries[slug] ?: 0) + 1
        tries[slug] = n
        if (n > MAX_TRIES) {
          Log.w(TAG, "$slug exceeded poll budget — dropping")
          untrack(slug)
          continue
        }
        pollOnce(creds.base, credential, slug)
      }
      updateSummary()
      try {
        Thread.sleep(POLL_MS)
      } catch (e: InterruptedException) {
        return
      }
    }
    stopSelf()
  }

  /** One status read for `slug`; posts/updates its notification accordingly. */
  private fun pollOnce(base: String, credential: OrcaApi.Credential, slug: String) {
    val (code, body) = try {
      OrcaApi.get(base, credential, "/api/items/$slug")
    } catch (e: Exception) {
      return // transient network hiccup — retry on the next tick
    }
    // Deleted while downloading: clear the notification so it can't linger as a
    // ghost the user has to swipe away.
    if (code == 404) {
      cancelNotif(applicationContext, notifId(slug))
      untrack(slug)
      return
    }
    if (code !in 200..299) return

    val item = try {
      JSONObject(body)
    } catch (e: Exception) {
      return
    }
    val siteName = item.optString("site_name").ifEmpty { item.optString("extractor") }
    val blur = item.optBoolean("blur", false)
    // A privacy-blurred site's real title must never land in a notification the
    // user has to clear by hand — mask it with the source's own video id.
    val videoName = if (blur) {
      item.optString("video_id").ifEmpty { "Download" }
    } else {
      item.optString("title").ifEmpty { "Download" }
    }
    val title = "${siteName.ifEmpty { "Orca" }} · $videoName"

    when (item.optString("status")) {
      "completed" -> {
        postItem(slug, title, "Download complete", -1, ongoing = false)
        untrack(slug)
      }
      "failed" -> {
        postItem(
          slug,
          title,
          item.optString("error").ifEmpty { "Download failed" },
          -1,
          ongoing = false,
        )
        untrack(slug)
      }
      "running" -> {
        val p = item.optJSONObject("progress")
        val pct = p?.optDouble("percent", -1.0)?.takeIf { !it.isNaN() && it >= 0 }?.toInt() ?: -1
        postItem(slug, title, runningText(p, pct), pct, ongoing = true)
      }
      // Queued: keep polling but post nothing. The share Toast already
      // acknowledged the queue, and a persistent "Queued…" was the redundant buzz.
      "queued" -> Unit
      else -> {
        cancelNotif(applicationContext, notifId(slug))
        untrack(slug)
      }
    }
  }

  /** "45% · 2.3MiB/s · ETA 00:12", degrading gracefully as fields go missing. */
  private fun runningText(p: JSONObject?, pct: Int): String {
    val parts = ArrayList<String>(3)
    if (pct >= 0) parts.add("$pct%")
    p?.optString("speed")?.takeIf { it.isNotEmpty() && it != "null" }?.let { parts.add(it) }
    p?.optString("eta")?.takeIf { it.isNotEmpty() && it != "null" }?.let { parts.add("ETA $it") }
    // A split (video+audio) download reports which pass is running.
    p?.optString("phase")?.takeIf { it.isNotEmpty() && it != "null" }?.let { parts.add(it) }
    return if (parts.isEmpty()) "Downloading…" else parts.joinToString(" · ")
  }

  private fun untrack(slug: String) {
    tracked.remove(slug)
  }

  /**
   * Submit a shared URL, report the outcome as a Toast, and start tracking the
   * resulting download. Every outcome is visible: success/duplicate/error all
   * surface, so the quick-download channel is never silent.
   */
  private fun submitAndTrack(url: String) {
    try {
      val creds = OrcaApi.readCreds(applicationContext) ?: return
      val credential = OrcaApi.credential(creds.token)
      var slug = ""
      var ok = false
      var duplicate = false
      val body = try {
        val payload = JSONObject().put("url", url).put("options", JSONObject()).toString()
        val (code, respText) = OrcaApi.post(creds.base, credential, "/api/items", payload)
        Log.i(TAG, "POST /api/items code=$code body=${respText.take(300)}")
        val resp = try { JSONObject(respText) } catch (e: Exception) { JSONObject() }
        when {
          code in 200..299 -> {
            ok = true
            slug = resp.optJSONObject("item")?.optString("slug") ?: ""
            duplicate = resp.optBoolean("duplicate")
            if (duplicate) "Already downloaded" else "Download queued"
          }
          code == 422 || resp.optString("error") == "probe_failed" ->
            resp.optString("message").ifEmpty { "Couldn't read that link" }
          code == 401 -> "Auth failed — open Orca and set your token"
          else -> "Submit failed (HTTP $code)"
        }
      } catch (e: Exception) {
        Log.e(TAG, "POST failed", e)
        "Can't reach the Orca server"
      }
      toast(applicationContext, "Orca · $body")

      if (ok && !duplicate && slug.isNotEmpty()) {
        // Hand off to the poll loop, which owns the notification from here on.
        tracked.putIfAbsent(slug, "")
        startPolling()
      } else if (!ok) {
        // A real failure still needs a tappable notification (the Toast is easy
        // to miss) so the user can reopen the app and retry with the real error.
        postNotif(
          applicationContext,
          (System.currentTimeMillis() % 100000).toInt(),
          "Orca",
          body,
          null,
          ongoing = false,
          pct = -1,
          retryUrl = url,
        )
      }
      // success + duplicate: Toast only — it's already downloaded, nothing to track.
    } finally {
      if (submitting.decrementAndGet() == 0 && tracked.isEmpty()) stopSelf()
    }
  }

  private fun postItem(slug: String, title: String, body: String, pct: Int, ongoing: Boolean) {
    // Skip a redundant re-post: identical text would be a no-op repaint.
    val key = "$title|$body|$pct|$ongoing"
    if (tracked[slug] == key) return
    if (tracked.containsKey(slug)) tracked[slug] = key
    postNotif(applicationContext, notifId(slug), title, body, slug, ongoing, pct)
  }

  private fun startForegroundSummary() {
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
    } else {
      0
    }
    try {
      ServiceCompat.startForeground(this, SUMMARY_ID, summaryNotification(), type)
    } catch (e: Exception) {
      Log.e(TAG, "startForeground failed", e)
    }
  }

  private fun updateSummary() {
    try {
      notificationManager(applicationContext).notify(SUMMARY_ID, summaryNotification())
    } catch (e: Exception) { /* best-effort */ }
  }

  /**
   * The foreground notification Android requires. It doubles as the group
   * summary so the system bundles it with the per-item notifications into one
   * collapsible entry instead of showing a second, redundant row.
   */
  private fun summaryNotification(): Notification {
    val n = tracked.size
    val text = if (n == 1) "Downloading 1 item" else "Downloading $n items"
    return builder(applicationContext)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("Orca")
      .setContentText(text)
      .setGroup(GROUP)
      .setGroupSummary(true)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setContentIntent(openAppIntent(applicationContext, null))
      .build()
  }

  companion object {
    private const val TAG = "OrcaDownloads"
    const val CHANNEL_ID = "quick_download"
    private const val GROUP = "com.orca.app.DOWNLOADS"
    private const val SUMMARY_ID = 199999
    private const val EXTRA_SLUG = "orca.slug"
    private const val EXTRA_URL = "orca.url"

    /** Notification id namespace: one stable slot per item, derived from its
     *  private slug, so progress updates replace in place instead of stacking. */
    private const val NOTIF_BASE = 200000
    private const val POLL_MS = 2000L

    /** ~10 min of polling per item at [POLL_MS]. */
    private const val MAX_TRIES = 300

    fun notifId(slug: String): Int = NOTIF_BASE + (slug.hashCode() and 0x0fffffff)

    /**
     * Start tracking `slug`'s download. Safe to call repeatedly for the same
     * slug. Must be called from a foreground context (an Activity or the share
     * target) — Android 12+ forbids starting a foreground service from the
     * background.
     */
    fun track(ctx: Context, slug: String) {
      if (slug.isEmpty()) return
      start(ctx, Intent(ctx, DownloadService::class.java).putExtra(EXTRA_SLUG, slug))
    }

    private fun start(ctx: Context, intent: Intent) {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          ctx.startForegroundService(intent)
        } else {
          ctx.startService(intent)
        }
      } catch (e: Exception) {
        // e.g. ForegroundServiceStartNotAllowedException if we somehow got here
        // from the background. Best-effort: the download itself is unaffected.
        Log.e(TAG, "start failed", e)
      }
    }

    private fun notificationManager(ctx: Context) =
      ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun builder(ctx: Context): Notification.Builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        notificationManager(ctx).createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_DEFAULT)
        )
        Notification.Builder(ctx, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(ctx)
      }

    /**
     * Tapping a notification opens the app AND scrolls to that download. The
     * slug rides along as an extra; MainActivity hands it to the WebView, which
     * focuses the row (see app.ts `focusItemBySlug`). Without this the tap did
     * nothing at all, which was the reported bug.
     */
    fun openAppIntent(ctx: Context, slug: String?): PendingIntent {
      val intent = Intent(ctx, MainActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (slug != null) putExtra(MainActivity.EXTRA_SLUG, slug)
      }
      // A per-slug request code keeps each item's PendingIntent distinct —
      // otherwise FLAG_UPDATE_CURRENT would rewrite them all to the same slug.
      return openAppPendingIntent(ctx, intent, (slug ?: "").hashCode())
    }

    private fun openAppPendingIntent(ctx: Context, intent: Intent, requestCode: Int): PendingIntent {
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
      return PendingIntent.getActivity(ctx, requestCode, intent, flags)
    }

    /** An intent that opens MainActivity (the WebView) with `url` prefilled so
     *  the frontend's drain path re-submits it and shows the real error toast. */
    fun openAppWithUrlIntent(ctx: Context, url: String): Intent =
      Intent(ctx, MainActivity::class.java).apply {
        action = Intent.ACTION_SEND
        type = "text/plain"
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        putExtra(Intent.EXTRA_TEXT, url)
      }

    /** Show a Toast from any thread (Toasts must be posted on the main looper). */
    fun toast(ctx: Context, msg: String) {
      val show = {
        Log.i(TAG, "toast=${msg.take(120)}")
        Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show()
      }
      if (Looper.myLooper() == Looper.getMainLooper()) show()
      else Handler(Looper.getMainLooper()).post(show)
    }

    /**
     * Submit a shared URL in the background and track the resulting download.
     * Must be called from a foreground context (see [track]).
     */
    fun submit(ctx: Context, url: String) {
      if (url.isEmpty()) return
      start(ctx, Intent(ctx, DownloadService::class.java).putExtra(EXTRA_URL, url))
    }

    /**
     * Post/replace a notification by stable id. `pct >= 0` draws a determinate
     * progress bar; `pct < 0` with `ongoing` draws an indeterminate one. Always
     * `onlyAlertOnce` so progress repaints never re-buzz.
     */
    fun postNotif(
      ctx: Context,
      notifId: Int,
      title: String,
      body: String,
      slug: String?,
      ongoing: Boolean,
      pct: Int,
      retryUrl: String? = null,
    ) {
      try {
        // Tapping a failed submit reopens the app with the link prefilled so the
        // user can read the real error / retry with cookies; every other
        // notification deep-links to its own row.
        val tap = if (retryUrl != null) {
          openAppPendingIntent(ctx, openAppWithUrlIntent(ctx, retryUrl), retryUrl.hashCode())
        } else {
          openAppIntent(ctx, slug)
        }
        val b = builder(ctx)
          .setSmallIcon(R.drawable.ic_notification)
          .setContentTitle(title)
          .setContentText(body)
          .setStyle(Notification.BigTextStyle().bigText(body))
          .setOnlyAlertOnce(true)
          .setOngoing(ongoing)
          // Dismissed only by the user (tap or swipe) — never on its own.
          .setAutoCancel(!ongoing)
          .setContentIntent(tap)
        if (ongoing) {
          // Only LIVE progress joins the group under the foreground summary. A
          // terminal notification must stand alone: the summary is removed the
          // moment the service stops — which happens immediately after
          // "Download complete" posts — and a group child can be swept with it.
          // That is why the completion notice flashed up and vanished.
          b.setGroup(GROUP)
          if (pct >= 0) b.setProgress(100, pct, false) else b.setProgress(0, 0, true)
        }
        notificationManager(ctx).notify(notifId, b.build())
      } catch (e: Exception) {
        // Notifications are best-effort; the download itself is unaffected.
      }
    }

    /** Remove a notification by id (best-effort). */
    fun cancelNotif(ctx: Context, notifId: Int) {
      try {
        notificationManager(ctx).cancel(notifId)
      } catch (e: Exception) { /* best-effort */ }
    }
  }
}
