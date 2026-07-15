package com.whale.app

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
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val NOTIFICATIONS = "notifications"

@TauriPlugin(
  permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = NOTIFICATIONS)]
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
  }

  @Command
  fun status(invoke: Invoke) {
    invoke.resolve(statusObject())
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

    val prefs = activity.getSharedPreferences("whale_permissions", Context.MODE_PRIVATE)
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

  private fun openNotificationSettings() {
    try {
      activity.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
        putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
      })
    } catch (_: Exception) {
      try {
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
          data = Uri.parse("package:${activity.packageName}")
        })
      } catch (_: Exception) { /* The returned status remains authoritative. */ }
    }
  }
}
