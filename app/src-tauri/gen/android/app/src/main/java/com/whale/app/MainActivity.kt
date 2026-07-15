package com.whale.app

import android.Manifest
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    applyImmersive(isLandscape(resources.configuration))
    // Ask for the permissions Whale needs to keep downloads/notifications alive
    // in the background — on first launch and every launch a permission is still
    // missing (unless the user opted out). Post-frame so it never blocks startup.
    window.decorView.post { maybePromptPermissions(force = false) }
  }

  override fun onResume() {
    super.onResume()
    // The in-app Settings "permissions" row (WebView → reset_permission_prompt
    // Tauri command) drops a sentinel file; honour it by re-showing the prompt
    // even if the user had previously opted out.
    if (permRequestFile().exists()) {
      permRequestFile().delete()
      optOutFile().delete()
      window.decorView.post { maybePromptPermissions(force = true) }
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyImmersive(isLandscape(newConfig))
  }

  private fun isLandscape(config: Configuration) =
    config.orientation == Configuration.ORIENTATION_LANDSCAPE

  // Landscape is video-watching: hide the system bars so fullscreen playback is
  // truly edge-to-edge (the earlier complaint was the status bar staying up).
  // A swipe brings the bars back transiently. Portrait restores them.
  private fun applyImmersive(hide: Boolean) {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    if (hide) {
      controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
    }
  }

  // ---- Runtime permissions (Android-DataBackup-style opt-in prompt) --------
  // A single, dismissable dialog (the mature platform AlertDialog, not a custom
  // view) that explains WHY Whale wants notifications + background power, then
  // hands off to the real system prompts. Nothing is forced: "Not now" re-asks
  // next launch, "Don't ask again" persists an opt-out the user can undo from the
  // in-app Settings. The opt-out and the settings-reset sentinel live in the same
  // app data dir the ShareActivity/Tauri bridge already shares.

  private fun optOutFile() = File(dataDir, "whale_perm_optout")
  private fun permRequestFile() = File(dataDir, "whale_perm_request")

  private fun needsNotifications(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

  private fun needsBattery(): Boolean {
    val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    return !pm.isIgnoringBatteryOptimizations(packageName)
  }

  private fun maybePromptPermissions(force: Boolean) {
    if (isFinishing) return
    if (!force && optOutFile().exists()) return
    val notif = needsNotifications()
    val batt = needsBattery()
    if (!notif && !batt) return

    val lines = ArrayList<String>()
    if (notif) lines.add(getString(R.string.perm_reason_notifications))
    if (batt) lines.add(getString(R.string.perm_reason_battery))
    val message = getString(R.string.perm_intro) + "\n\n" + lines.joinToString("\n")

    AlertDialog.Builder(this)
      .setTitle(R.string.perm_title)
      .setMessage(message)
      .setPositiveButton(R.string.perm_allow) { _, _ -> requestNeeded(notif, batt) }
      .setNegativeButton(R.string.perm_not_now, null)
      .setNeutralButton(R.string.perm_never) { _, _ ->
        try { optOutFile().createNewFile() } catch (_: Exception) { /* best-effort */ }
      }
      .show()
  }

  private fun requestNeeded(notif: Boolean, batt: Boolean) {
    if (notif && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      try {
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
      } catch (_: Exception) { /* ignore — user can retry from settings */ }
    }
    if (batt) {
      // The exact-exemption intent; if the OEM blocks it, fall back to the
      // battery-optimization list so the user can still find Whale.
      try {
        startActivity(
          Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:$packageName")
          )
        )
      } catch (_: Exception) {
        try {
          startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (_: Exception) { /* nothing more we can do */ }
      }
    }
  }

  companion object {
    private const val REQ_NOTIFICATIONS = 1001
  }
}
