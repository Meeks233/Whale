package com.orca.app

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    consumeDeepLink(intent)
    applyImmersive(isLandscape(resources.configuration))
  }

  // launchMode is singleTask, so tapping a notification while the app is already
  // running re-uses this instance and arrives here rather than in onCreate().
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    consumeDeepLink(intent)
  }

  /**
   * A download notification was tapped: stash the item slug so the WebView can
   * pick it up (`take_pending_deeplink`) and scroll to that row. Native code
   * can't call into the frontend directly, and the WebView may not have booted
   * yet on a cold start, so the frontend pulls rather than us pushing.
   */
  private fun consumeDeepLink(incoming: Intent?) {
    val slug = incoming?.getStringExtra(EXTRA_SLUG)?.takeIf { it.isNotEmpty() } ?: return
    pendingSlug = slug
  }

  companion object {
    const val EXTRA_SLUG = "orca.slug"

    /** Set by a notification tap, drained once by the frontend. */
    @Volatile
    var pendingSlug: String? = null

    fun takePendingSlug(): String? {
      val slug = pendingSlug
      pendingSlug = null
      return slug
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
}
