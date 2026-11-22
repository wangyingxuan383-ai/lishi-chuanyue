package io.timejump.chuanyue

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var agentBrowser: AgentBrowserHost? = null
  private var webView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    agentBrowser = AgentBrowserHost(this)

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
    // Bars in the app's theme from the first frame (the page sets them again once loaded).
    SystemBars.restore(this)
    LaunchTarget.capture(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // A tapped "写好了" or "没写完": capture, clear ready notices, and wake the page immediately
    // (tapping a notification while already in foreground or split-screen does not fire visibilitychange).
    if (LaunchTarget.capture(intent)) {
      GenerationService.clearReady(this)
      webView?.post {
        webView?.evaluateJavascript("window.dispatchEvent(new Event('lishi:launch-target'))", null)
      }
    }
  }

  override fun onDestroy() {
    webView = null
    agentBrowser?.destroy(); agentBrowser = null
    super.onDestroy()
  }

  override fun onResume() {
    super.onResume()
    // Back in the app: the "写好了" notification has done its job.
    GenerationService.clearReady(this)
  }
}
