package io.timejump.chuanyue

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.annotation.Keep
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The independent agent process never initializes a WebView. */
@Keep
object AgentBrowserClient {
    private fun error(message: String) = JSONObject().put("isError", true).put("error", JSONObject().put("code", "browser_host_unavailable").put("message", message)).toString()
    @JvmStatic fun execute(context: Context, payload: String): String {
        val marker = File(context.filesDir, "agent-browser.ready")
        val pid = runCatching { marker.readText().toInt() }.getOrNull()
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        if (pid == null || manager.runningAppProcesses?.none { it.pid == pid && it.processName == context.packageName } != false) return error("网页宿主未连接，请返回APP后重试；也可继续使用HTTP网页读取。")
        val id = UUID.randomUUID().toString(); val latch = CountDownLatch(1)
        val replyFile = File(File(context.filesDir, "agent-browser-replies"), "$id.json")
        val receiver = object : BroadcastReceiver() { override fun onReceive(c: Context, intent: Intent) { if (intent.getStringExtra("id") == id) latch.countDown() } }
        ContextCompat.registerReceiver(context, receiver, IntentFilter(context.packageName + ".AGENT_BROWSER_REPLY"), ContextCompat.RECEIVER_NOT_EXPORTED)
        try {
            context.sendBroadcast(Intent(context.packageName + ".AGENT_BROWSER").setPackage(context.packageName).putExtra("id", id).putExtra("payload", payload))
            if (!latch.await(26, TimeUnit.SECONDS)) { cancel(context, payload); return error("网页宿主响应超时，未取得页面内容。") }
            if (!replyFile.exists() || replyFile.length() > 2L * 1024 * 1024) return error("网页快照未保存或超出读取范围。")
            return replyFile.readText(Charsets.UTF_8)
        } catch (_: Exception) { cancel(context, payload); return error("网页读取已中断，未确认取得资料。") }
        finally { context.unregisterReceiver(receiver); replyFile.delete() }
    }
    @JvmStatic fun cancel(context: Context, payload: String) {
        val request = runCatching { JSONObject(payload) }.getOrNull() ?: return
        request.put("op", "browser_cancel")
        context.sendBroadcast(Intent(context.packageName + ".AGENT_BROWSER").setPackage(context.packageName).putExtra("payload", request.toString()))
    }
}
