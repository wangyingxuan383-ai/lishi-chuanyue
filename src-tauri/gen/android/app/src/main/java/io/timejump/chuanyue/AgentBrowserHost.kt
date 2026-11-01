package io.timejump.chuanyue

import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.webkit.*
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Reading-only, ordinary WebViews with no Tauri scripts or JavascriptInterface. */
class AgentBrowserHost(private val activity: Activity) {
    private class Page(val view: WebView, val task: String, val attempt: String, val actor: String) { var operation = ""; var pending = ""; var loading = false; var navigation = 0 }
    private val pages = LinkedHashMap<String, Page>()
    private val replies = HashMap<String, JSONObject>()
    private val cancelled = LinkedHashSet<String>()
    private val handler = Handler(Looper.getMainLooper())
    private val ready = File(activity.filesDir, "agent-browser.ready")
    private val receiver = object : BroadcastReceiver() { override fun onReceive(context: Context, intent: Intent) {
        val request = runCatching { JSONObject(intent.getStringExtra("payload") ?: "") }.getOrNull() ?: return
        accept(intent.getStringExtra("id") ?: "", request)
    } }
    init {
        ContextCompat.registerReceiver(activity, receiver, IntentFilter(activity.packageName + ".AGENT_BROWSER"), ContextCompat.RECEIVER_NOT_EXPORTED)
        ready.writeText(Process.myPid().toString())
        File(activity.filesDir, "agent-browser-replies").listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 120000 }?.forEach { it.delete() }
    }
    private fun error(message: String, code: String = "browser_unavailable") = JSONObject().put("isError", true).put("error", JSONObject().put("code", code).put("message", message))
    private fun allowed(url: String): Boolean = runCatching { val u = Uri.parse(url); u.scheme in setOf("https", "http") && !u.host.isNullOrEmpty() && u.userInfo == null }.getOrDefault(false)
    private fun owns(page: Page, q: JSONObject) = page.task == q.optString("taskId") && page.attempt == q.optString("attemptId") && (q.optString("op") == "browser_release_task" || page.actor == q.optString("actorId"))
    private fun reply(id: String, value: JSONObject) {
        if (id.isEmpty() || replies.remove(id) == null) return
        runCatching {
            val directory = File(activity.filesDir, "agent-browser-replies").apply { mkdirs() }
            val temporary = File(directory, "$id.tmp"); val target = File(directory, "$id.json")
            temporary.writeText(value.toString(), Charsets.UTF_8)
            if (!temporary.renameTo(target)) { temporary.delete(); return@runCatching }
            activity.sendBroadcast(Intent(activity.packageName + ".AGENT_BROWSER_REPLY").setPackage(activity.packageName).putExtra("id", id))
        }
    }
    private fun close(id: String, reason: String) {
        val page = pages.remove(id) ?: return
        page.view.stopLoading(); page.view.destroy()
        if (page.pending.isNotEmpty()) reply(page.pending, error(reason))
    }
    private fun extract(id: String, q: JSONObject) {
        val page = pages[id] ?: return
        if (!owns(page, q) || page.operation != q.optString("operationId") || page.pending.isEmpty()) return
        val pending = page.pending
        page.view.evaluateJavascript(q.getString("_snapshotScript")) { raw ->
            val current = pages[id]
            if (current !== page || page.pending != pending || page.operation != q.optString("operationId")) return@evaluateJavascript
            val value = runCatching { JSONObject(raw) }.getOrElse { error("页面不允许提取正文。", "page_unreadable") }
            if (value.optBoolean("isError") || allowed(value.optString("url"))) value.put("browserId", id)
            else {
                page.pending = ""; page.operation = ""
                val detail = error("页面尚未进入可读取的HTTP/HTTPS正文，请重新打开。", "page_not_ready")
                if (BuildConfig.DEBUG) detail.put("diagnostic", JSONObject().put("nativeScheme", Uri.parse(page.view.url ?: "").scheme).put("snapshotScheme", Uri.parse(value.optString("url")).scheme).put("fields", value.names()))
                reply(pending, detail); return@evaluateJavascript
            }
            page.pending = ""; page.operation = ""; reply(pending, value)
        }
    }
    @SuppressLint("SetJavaScriptEnabled")
    private fun accept(replyId: String, q: JSONObject) {
        val op = q.optString("op"); val operation = q.optString("operationId")
        if (op == "browser_cancel") {
            cancelled.add(operation); while (cancelled.size > 256) cancelled.remove(cancelled.first())
            pages.filterValues { owns(it, q) && it.operation == operation }.keys.toList().forEach { close(it, "网页读取已停止。") }; return
        }
        if (runCatching { UUID.fromString(replyId) }.isFailure) return
        replies[replyId] = q
        if (op == "browser_release_task" || op == "browser_close") {
            pages.filter { (id, page) -> owns(page, q) && (op == "browser_release_task" || id == q.optString("browserId")) }.keys.toList().forEach { close(it, "资料页面已关闭。") }
            reply(replyId, JSONObject().put("closed", true)); return
        }
        if (operation.isEmpty() || cancelled.contains(operation)) { reply(replyId, error("网页操作已停止。")); return }
        var id = q.optString("browserId")
        if (op == "browser_open") {
            val url = q.optString("url")
            if (!allowed(url)) { reply(replyId, error("只支持HTTP/HTTPS资料地址。")); return }
            if (pages.size >= 4) { reply(replyId, error("最多同时打开4个资料页面，请先关闭已读页面。")); return }
            id = UUID.randomUUID().toString()
            val view = WebView(activity)
            view.settings.apply {
                javaScriptEnabled = true; domStorageEnabled = false; databaseEnabled = false
                allowFileAccess = false; allowContentAccess = false; javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false); saveFormData = false; mediaPlaybackRequiresUserGesture = true
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }
            view.isFocusable = false; view.isFocusableInTouchMode = false
            view.setDownloadListener { _, _, _, _, _ -> }
            view.webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
                override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) { callback?.invoke(origin, false, false) }
                override fun onShowFileChooser(webView: WebView?, callback: android.webkit.ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean { callback?.onReceiveValue(null); return true }
                override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean { result?.cancel(); return true }
                override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean { result?.cancel(); return true }
                override fun onJsPrompt(view: WebView?, url: String?, message: String?, defaultValue: String?, result: JsPromptResult?): Boolean { result?.cancel(); return true }
            }
            val pageId = id
            view.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = request == null || !allowed(request.url.toString())
                @Deprecated("Compatibility") override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = url == null || !allowed(url)
                override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                    if (url == null || !allowed(url)) return
                    pages[pageId]?.let { it.loading = true; it.navigation++ }
                }
                override fun onPageFinished(view: WebView?, url: String?) {
                    val page = pages[pageId] ?: return
                    if (url == null || !allowed(url) || view?.url != url) return
                    page.loading = false
                    val pending = replies[page.pending] ?: return
                    val navigation = page.navigation
                    handler.postDelayed({ if (pages[pageId] === page && !page.loading && page.navigation == navigation && page.view.url == url) extract(pageId, pending) }, 500)
                }
                override fun onReceivedError(view: WebView?, request: WebResourceRequest?, failure: WebResourceError?) {
                    if (request?.isForMainFrame == true) close(pageId, "网页加载失败，未取得正文（网络错误${failure?.errorCode ?: 0}）。")
                }
                override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, response: WebResourceResponse?) {
                    if (request?.isForMainFrame == true && (response?.statusCode ?: 0) >= 400) close(pageId, "网页返回HTTP ${response?.statusCode}，未作为资料正文读取。")
                }
                override fun onReceivedHttpAuthRequest(view: WebView?, handler: HttpAuthHandler?, host: String?, realm: String?) { handler?.cancel() }
                override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: android.net.http.SslError?) { handler?.cancel(); close(pageId, "网页证书无效，未读取资料。") }
            }
            pages[id] = Page(view, q.optString("taskId"), q.optString("attemptId"), q.optString("actorId"))
        }
        val page = pages[id]
        if (page == null || !owns(page, q)) { reply(replyId, error("页面不属于当前任务或执行批次，请重新打开。")); return }
        if (page.pending.isNotEmpty()) { reply(replyId, error("同一网页正在读取，请等待上一操作结束。")); return }
        page.pending = replyId; page.operation = operation
        handler.postDelayed({ if (pages[id] === page && page.pending == replyId) close(id, "网页加载或提取超时，未取得资料。") }, 24000)
        when (op) {
            "browser_open" -> { page.loading = true; page.view.loadUrl(q.getString("url")) }
            "browser_follow" -> { val url = q.optString("_followUrl"); if (allowed(url)) { page.loading = true; page.view.loadUrl(url) } else close(id, "页面链接无效。") }
            "browser_read", "browser_find" -> if (!page.loading) extract(id, q)
            else -> close(id, "不支持的网页操作。")
        }
    }
    fun destroy() {
        if (ready.readTextOrNull() == Process.myPid().toString()) ready.delete()
        pages.keys.toList().forEach { close(it, "网页宿主已经退出，可重新打开APP后继续。") }
        activity.unregisterReceiver(receiver)
    }
    private fun File.readTextOrNull() = runCatching { readText() }.getOrNull()
}
