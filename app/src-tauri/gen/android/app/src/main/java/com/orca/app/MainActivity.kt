package com.orca.app

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
    applyImmersive(isLandscape(resources.configuration))
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
