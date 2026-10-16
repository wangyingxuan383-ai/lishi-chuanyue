package io.timejump.chuanyue

import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Required for IME insets on older Android versions; the content listener
    // also keeps the WebView above the keyboard with enforced edge-to-edge.
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)

    val content = findViewById<View>(android.R.id.content)
    val initialLeft = content.paddingLeft
    val initialTop = content.paddingTop
    val initialRight = content.paddingRight
    val initialBottom = content.paddingBottom
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      // The combined types use the largest inset on each edge, so the keyboard
      // and navigation bar are not added twice. Preserve only the initial
      // padding instead of accumulating it on each keyboard transition.
      val safeInsets = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(
        initialLeft + safeInsets.left,
        initialTop + safeInsets.top,
        initialRight + safeInsets.right,
        initialBottom + safeInsets.bottom
      )
      // The native parent owns these insets; do not let the WebView apply the
      // same system-bar or keyboard space again.
      WindowInsetsCompat.CONSUMED
    }
    content.post { ViewCompat.requestApplyInsets(content) }
  }
}
