package io.timejump.chuanyue

import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  private var agentBrowser: AgentBrowserHost? = null
  private var webView: WebView? = null

  private fun hardenWebView(view: WebView) {
    // Prevent OEM system 130%+ fontScale from double-scaling CSS px on top of the app's own font-size slider.
    view.settings.textZoom = 100
    // Disable OEM forced dark inversion so our paper / day / night CSS tokens stay exact.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      view.isForceDarkAllowed = false
    }
    try {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
        WebSettingsCompat.setAlgorithmicDarkeningAllowed(view.settings, false)
      }
      if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
        @Suppress("DEPRECATION")
        WebSettingsCompat.setForceDark(view.settings, WebSettingsCompat.FORCE_DARK_OFF)
      }
    } catch (_: Throwable) {
      // Older OEM WebView builds may lack feature query stubs; ignore safely.
    }
  }

  private fun refreshShell(dispatchResume: Boolean) {
    SystemBars.restore(this)
    findViewById<View>(android.R.id.content)?.let { content ->
      ViewCompat.requestApplyInsets(content)
      content.post { ViewCompat.requestApplyInsets(content) }
    }
    if (dispatchResume) {
      webView?.post {
        webView?.evaluateJavascript("window.dispatchEvent(new Event(\"lishi:app-resume\"))", null)
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    hardenWebView(webView)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    agentBrowser = AgentBrowserHost(this)

    // Required for IME insets on older Android versions; the content listener
    // also keeps the WebView above the keyboard with enforced edge-to-edge.
    @Suppress("DEPRECATION")
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
    // Bars in the app's theme from the first frame (defaults to #EFE5CF paper before JS boots).
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

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    webView?.let { hardenWebView(it) }
    refreshShell(dispatchResume = true)
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
    webView?.let { hardenWebView(it) }
    refreshShell(dispatchResume = true)
  }
}
