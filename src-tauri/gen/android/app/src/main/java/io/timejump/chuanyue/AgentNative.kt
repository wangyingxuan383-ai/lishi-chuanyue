package io.timejump.chuanyue

import android.content.Context

/** Only the dedicated service calls JNI; no credential getter crosses IPC. */
object AgentNative {
    interface Sink {
        fun reply(handle: Long, requestId: Long, response: String)
        fun activity(handle: Long, active: Boolean)
    }
    @Volatile private var sink: Sink? = null
    private var loaded = false
    @Synchronized fun install(value: Sink) {
        if (!loaded) { System.loadLibrary("lishi_agent_host"); loaded = true }
        sink = value
    }
    fun remove(value: Sink) { if (sink === value) sink = null }
    @JvmStatic external fun nativeInitialize(context: Context, dataRoot: String, runtimeRoot: String, rustSocketFd: Int): Long
    @JvmStatic external fun nativeDispatch(handle: Long, requestId: Long, operation: String, json: String)
    @JvmStatic external fun nativeRuntimeExited(handle: Long, exitCode: Int): Boolean
    @JvmStatic external fun nativeShutdown(handle: Long): Boolean
    @JvmStatic fun onNativeReply(handle: Long, requestId: Long, response: String) { sink?.reply(handle, requestId, response) }
    @JvmStatic fun onNativeActivity(handle: Long, active: Boolean) { sink?.activity(handle, active) }
}
