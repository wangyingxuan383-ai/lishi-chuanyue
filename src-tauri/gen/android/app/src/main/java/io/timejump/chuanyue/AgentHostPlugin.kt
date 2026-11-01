package io.timejump.chuanyue

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors

/** Internal native facade only; no key resolver or plaintext credential IPC. */
@TauriPlugin class AgentHostPlugin(private val activity: Activity) : Plugin(activity) {
    private val worker = Executors.newFixedThreadPool(2)
    private val control = Executors.newSingleThreadExecutor()
    @Command fun cancelExisting(invoke: Invoke) {
        val request = invoke.getArgs().getJSObject("request")
        if (request == null || request.optString("op") !in setOf("stop", "force_stop_attempt", "retire_host")) { invoke.reject("invalid_control"); return }
        control.execute {
            try { val result=AgentHostBridge.requestBlocking(activity.applicationContext,request.toString(),5_000,true)
                if (request.optString("op")=="retire_host" && !AgentHostBridge.awaitDisconnected()) throw IllegalStateException("host still connected")
                activity.runOnUiThread { invoke.resolve(JSObject().put("json",result)) }
            } catch (_: Exception) {
                if (request.optString("op")=="retire_host" && !AgentHostBridge.awaitDisconnected()) activity.runOnUiThread { invoke.reject("助手服务尚未退出，未恢复存档") }
                else activity.runOnUiThread { invoke.resolve(JSObject().put("hostAbsent",true)) }
            }
        }
    }
    @Command fun request(invoke: Invoke) {
        // Jackson's bean mapper does not populate JSONObject's dynamic keys.
        // Keep the command envelope intact, including nested task settings.
        val request = invoke.getArgs().getJSObject("request")
        if (request == null || request.optString("op").isBlank()) {
            invoke.reject("助手请求缺少操作类型")
            return
        }
        val payload = request.toString()
        (if (request.optString("op") == "stop") control else worker).execute {
            try {
                val result = AgentHostBridge.requestBlocking(activity.applicationContext, payload)
                activity.runOnUiThread { invoke.resolve(JSObject().put("json", result)) }
            } catch (_: Exception) { activity.runOnUiThread { invoke.reject("助手服务未完成请求，任务进度已保留") } }
        }
    }
}
