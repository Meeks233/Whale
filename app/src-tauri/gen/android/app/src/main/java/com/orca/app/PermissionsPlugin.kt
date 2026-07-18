package com.orca.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val NOTIFICATIONS = "notifications"
private const val STORAGE = "storage"

@InvokeArg
class SlugArgs {
  var slug: String? = null
}

/** One item to look up, with the server's fingerprint for its file. */
@InvokeArg
class LocalQuery {
  var slug: String? = null
  /** Name the server serves the file under; empty when it has no local file. */
  var name: String? = null
  /** Exact byte size of that file; 0 when unknown — never adopted. */
  var size: Long = 0
  var height: Int = 0
}

@InvokeArg
class LocalFilesArgs {
  var items: List<LocalQuery> = emptyList()
}

@InvokeArg
class SaveArgs {
  var url: String? = null
  var name: String? = null
  /** Item slug, so the saved file can be found again for local playback. */
  var slug: String? = null
  /** Pixel height being saved; 0 when unknown. Lets a later, taller save
   *  recognise itself as an upgrade of this one. */
  var height: Int = 0
}

@InvokeArg
class HideArgs {
  var hidden: Boolean = false
}

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = NOTIFICATIONS),
    Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = STORAGE),
  ]
)
class PermissionsPlugin(private val activity: Activity) : Plugin(activity) {
  private fun notificationsGranted(): Boolean =
    NotificationManagerCompat.from(activity).areNotificationsEnabled() &&
      (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

  private fun backgroundGranted(): Boolean {
    val power = activity.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    return power.isIgnoringBatteryOptimizations(activity.packageName)
  }

  private fun statusObject(): JSObject = JSObject().apply {
    put("notifications", notificationsGranted())
    put("background", backgroundGranted())
    put("storage", MediaSaver.granted(activity))
    put("hideDownloads", MediaSaver.isHidden(activity))
  }

  @Command
  fun status(invoke: Invoke) {
    invoke.resolve(statusObject())
  }

  /**
   * Hand a download submitted from inside the app to [DownloadService], so its
   * notification comes from the same owner as a shared link's and survives the
   * app being backgrounded. Called from the activity, which is foreground —
   * a requirement for starting a foreground service.
   */
  @Command
  fun trackDownload(invoke: Invoke) {
    val slug = invoke.parseArgs(SlugArgs::class.java).slug
    if (!slug.isNullOrEmpty()) DownloadService.track(activity, slug)
    invoke.resolve()
  }

  /**
   * Drain the slug stashed by a notification tap (see MainActivity). Returns
   * `{ slug: null }` when there is nothing pending. The frontend polls this on
   * launch/resume and scrolls to the matching row.
   */
  @Command
  fun takePendingDeeplink(invoke: Invoke) {
    val slug = MainActivity.takePendingSlug()
    // Only set the key when there is one: putting a null would drop it anyway,
    // and the Rust side defaults a missing `slug` to None.
    invoke.resolve(JSObject().apply { if (slug != null) put("slug", slug) })
  }

  @Command
  fun requestNotifications(invoke: Invoke) {
    if (notificationsGranted()) {
      invoke.resolve(statusObject())
      return
    }

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      openNotificationSettings()
      invoke.resolve(statusObject())
      return
    }

    val prefs = activity.getSharedPreferences("orca_permissions", Context.MODE_PRIVATE)
    val requestedBefore = prefs.getBoolean("notifications_requested", false)
    if (requestedBefore && !activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
      openNotificationSettings()
      invoke.resolve(statusObject())
      return
    }

    prefs.edit().putBoolean("notifications_requested", true).apply()
    requestPermissionForAlias(NOTIFICATIONS, invoke, "notificationsCallback")
  }

  @PermissionCallback
  private fun notificationsCallback(invoke: Invoke) {
    // An existing install may already be USER_FIXED from the old prompt flow,
    // while this plugin's own "requested" preference does not exist yet. Android
    // then completes the runtime request immediately without showing anything.
    // Finish the same click by opening app notification settings instead of
    // making the user discover that a second tap is required.
    if (!notificationsGranted() &&
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      !activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
    ) {
      openNotificationSettings()
    }
    invoke.resolve(statusObject())
  }

  /**
   * Ask for permission to write shared storage.
   *
   * On API 30+ "All files access" is NOT a runtime dialog — the only way to get
   * it is to send the user to a Settings screen and re-check on resume. On 28/29
   * it is an ordinary runtime grant. Returning the (unchanged) status here is
   * correct in the Settings case: the frontend re-reads status on resume, which
   * is when the real answer arrives.
   */
  @Command
  fun requestStorage(invoke: Invoke) {
    if (MediaSaver.granted(activity)) {
      invoke.resolve(statusObject())
      return
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      openAllFilesAccessSettings()
      invoke.resolve(statusObject())
      return
    }

    // Same "already permanently denied" guard as notifications: once the OS
    // stops showing the dialog, a request is a no-op, so go to Settings instead
    // of leaving the button looking broken.
    val prefs = activity.getSharedPreferences("orca_permissions", Context.MODE_PRIVATE)
    val requestedBefore = prefs.getBoolean("storage_requested", false)
    if (requestedBefore &&
      !activity.shouldShowRequestPermissionRationale(Manifest.permission.WRITE_EXTERNAL_STORAGE)
    ) {
      openAppDetailsSettings()
      invoke.resolve(statusObject())
      return
    }
    prefs.edit().putBoolean("storage_requested", true).apply()
    requestPermissionForAlias(STORAGE, invoke, "storageCallback")
  }

  @PermissionCallback
  private fun storageCallback(invoke: Invoke) {
    if (!MediaSaver.granted(activity) &&
      !activity.shouldShowRequestPermissionRationale(Manifest.permission.WRITE_EXTERNAL_STORAGE)
    ) {
      openAppDetailsSettings()
    }
    invoke.resolve(statusObject())
  }

  /**
   * Save a finished item to shared storage. Handed to [DownloadService] rather
   * than done here: the transfer must not run on the main thread, and must
   * outlive the WebView being backgrounded.
   */
  @Command
  fun saveMedia(invoke: Invoke) {
    val args = invoke.parseArgs(SaveArgs::class.java)
    val url = args.url
    if (url.isNullOrEmpty()) {
      invoke.reject("missing url")
      return
    }
    if (!MediaSaver.granted(activity)) {
      invoke.reject("storage_denied")
      return
    }
    DownloadService.save(activity, url, args.name.orEmpty(), args.slug.orEmpty(), args.height)
    invoke.resolve(statusObject())
  }

  /**
   * Which of [LocalFilesArgs.items] have a copy on this device. Backs both the
   * player's "play the file here rather than stream it back from the server"
   * path and the green Save icon on a card.
   *
   * Batched, and off the main thread: the frontend asks about a whole page at
   * once, and the answer costs one directory listing for the lot (see
   * [MediaSaver.FolderIndex]). Answers come back in request order; an item with
   * no local copy resolves to an empty object rather than dropping out, so the
   * caller can zip the two lists.
   */
  @Command
  fun localFiles(invoke: Invoke) {
    val items = invoke.parseArgs(LocalFilesArgs::class.java).items
    // Not gated on the storage permission: a file we saved while permitted stays
    // readable, and refusing to report it would strand playback if the grant is
    // later revoked.
    Thread {
      try {
        val index = MediaSaver.folderIndex(activity)
        val out = org.json.JSONArray()
        for (q in items) {
          val slug = q.slug.orEmpty()
          val local = MediaSaver.resolve(activity, slug, q.name.orEmpty(), q.size, q.height, index)
          out.put(
            if (local == null) JSObject() else JSObject().apply {
              put("path", local.path)
              put("height", local.height)
              // The URL is what the player actually uses; `path` is retained for
              // diagnostics. See LocalMediaServer for why asset:// can't work.
              put("url", LocalMediaServer.urlFor(activity, slug).orEmpty())
            }
          )
        }
        invoke.resolve(JSObject().apply { put("files", out) })
      } catch (e: Exception) {
        invoke.reject(e.message ?: "could not read local files")
      }
    }.start()
  }

  /**
   * Delete this device's saved copies of the given items and forget them, so the
   * user can reclaim the space while the server records stay put (they still
   * stream). Batched and off the main thread, like [localFiles]: one directory
   * listing resolves the lot. Resolves `{ deleted: n }` — the number of real
   * files actually removed.
   */
  @Command
  fun deleteLocal(invoke: Invoke) {
    val items = invoke.parseArgs(LocalFilesArgs::class.java).items
    Thread {
      try {
        val index = MediaSaver.folderIndex(activity)
        var deleted = 0
        for (q in items) {
          val slug = q.slug.orEmpty()
          if (slug.isEmpty()) continue
          if (MediaSaver.deleteLocal(activity, slug, q.name.orEmpty(), q.size, q.height, index)) deleted++
        }
        invoke.resolve(JSObject().apply { put("deleted", deleted) })
      } catch (e: Exception) {
        invoke.reject(e.message ?: "could not delete local files")
      }
    }.start()
  }

  /**
   * Flip the hidden-folder setting, migrating everything already saved. The move
   * is filesystem work, so it runs off the main thread; the frontend awaits the
   * resolve to report how many files moved.
   */
  @Command
  fun setHideDownloads(invoke: Invoke) {
    val hidden = invoke.parseArgs(HideArgs::class.java).hidden
    if (!MediaSaver.granted(activity)) {
      invoke.reject("storage_denied")
      return
    }
    Thread {
      try {
        val moved = MediaSaver.setHidden(activity, hidden)
        invoke.resolve(statusObject().apply { put("moved", moved) })
      } catch (e: Exception) {
        invoke.reject(e.message ?: "could not move downloads")
      }
    }.start()
  }

  @Command
  fun requestBackground(invoke: Invoke) {
    if (!backgroundGranted()) {
      try {
        activity.startActivity(
          Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${activity.packageName}")
          )
        )
      } catch (_: Exception) {
        try {
          activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (_: Exception) { /* The returned status remains authoritative. */ }
      }
    }
    invoke.resolve(statusObject())
  }

  /**
   * The API 30+ "All files access" screen, targeted at this app. The generic
   * list (no package uri) is the documented fallback for OEM builds that reject
   * the targeted intent — the user then picks Orca from the list themselves.
   */
  private fun openAllFilesAccessSettings() {
    try {
      activity.startActivity(
        Intent(
          Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
          Uri.parse("package:${activity.packageName}"),
        )
      )
    } catch (_: Exception) {
      try {
        activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
      } catch (_: Exception) {
        openAppDetailsSettings()
      }
    }
  }

  private fun openAppDetailsSettings() {
    try {
      activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.parse("package:${activity.packageName}")
      })
    } catch (_: Exception) { /* The returned status remains authoritative. */ }
  }

  private fun openNotificationSettings() {
    try {
      activity.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
        putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
      })
    } catch (_: Exception) {
      openAppDetailsSettings()
    }
  }
}
