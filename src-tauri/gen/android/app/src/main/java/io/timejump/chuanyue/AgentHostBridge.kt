package io.timejump.chuanyue

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.security.SecureRandom

/** App-context binding survives leaving the Agent page. Disconnect never sends stop. */
object AgentHostBridge {
    private val main = Handler(Looper.getMainLooper())
    private val sequence = AtomicLong((SecureRandom().nextLong().ushr(1)).coerceAtLeast(1))
    private val pending = ConcurrentHashMap<Long, CompletableFuture<String>>()
    @Volatile private var remote: Messenger? = null
    private var connecting: CompletableFuture<Messenger>? = null
    private var connection: ServiceConnection? = null
    private var replies: Messenger? = null

    private fun receiver(app: Context): Messenger = replies ?: Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(message: Message) {
            if (message.what != AgentIpc.REPLY) return
            val id = message.data.getLong("id")
            try {
                val value = AgentIpc.read(app, message.data)
                if (id > 0) pending.remove(id)?.complete(value)
                // id=0 is a service event. Persisted task/event snapshots are
                // authoritative; a page can reconnect without this notification.
            } catch (_: Exception) {
                pending.remove(id)?.completeExceptionally(IllegalStateException("助手回复读取失败"))
            }
        }
    }).also { replies = it }

    private fun connect(app: Context): CompletableFuture<Messenger> {
        check(Looper.myLooper() == Looper.getMainLooper())
        remote?.let { return CompletableFuture.completedFuture(it) }
        connecting?.let { return it }
        val ready = CompletableFuture<Messenger>()
        connecting = ready
        val link = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                val value = Messenger(binder)
                remote = value
                connecting = null
                ready.complete(value)
            }
            override fun onServiceDisconnected(name: ComponentName) { lost() }
            override fun onBindingDied(name: ComponentName) { lost() }
            override fun onNullBinding(name: ComponentName) { lost() }
            private fun lost() {
                remote = null
                connecting = null
                ready.completeExceptionally(IllegalStateException("助手服务已断开，进度已保存"))
                pending.values.forEach { it.completeExceptionally(IllegalStateException("助手服务已断开，进度已保存")) }
                pending.clear()
                try { app.unbindService(this) } catch (_: Exception) { }
                if (connection === this) connection = null
            }
        }
        connection = link
        if (!app.bindService(Intent(app, AgentHostService::class.java), link, Context.BIND_AUTO_CREATE)) {
            connecting = null
            connection = null
            ready.completeExceptionally(IllegalStateException("无法连接助手服务"))
        }
        return ready
    }

    fun awaitDisconnected(): Boolean {
        val until=System.nanoTime()+5_000_000_000L
        while(remote!=null && System.nanoTime()<until) Thread.sleep(20)
        return remote==null
    }

    /** Call from a native/plugin worker, never from the main Looper. */
    @JvmStatic fun requestBlocking(value: Context, request: String, timeoutMs: Long = 120_000, onlyIfConnected: Boolean = false): String {
        check(Looper.myLooper() != Looper.getMainLooper())
        val app = value.applicationContext
        val payload = JSONObject(request)
        require(!payload.has("apiKey") && !payload.optJSONObject("model").let { it?.has("apiKey") == true })
        val id = sequence.getAndIncrement()
        check(id > 0)
        val result = CompletableFuture<String>()
        val data = Bundle().apply { putLong("id", id); AgentIpc.put(app, this, request) }
        pending[id] = result
        main.post {
            try {
                val op = payload.optString("op")
                if (op in setOf("start", "continue")) {
                    val intent = Intent(app, AgentHostService::class.java).setAction(AgentHostService.PREPARE_RUN)
                    if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(intent) else app.startService(intent)
                }
                if (onlyIfConnected && remote == null) {
                    AgentIpc.discard(app, data)
                    pending.remove(id)?.complete("{\"ok\":true,\"data\":{\"hostAbsent\":true}}")
                    return@post
                }
                (if (onlyIfConnected) CompletableFuture.completedFuture(remote!!) else connect(app)).whenComplete { messenger, error ->
                    if (error != null) {
                        AgentIpc.discard(app, data)
                        pending.remove(id)?.completeExceptionally(error)
                    } else try {
                        val message = Message.obtain(null, AgentIpc.COMMAND)
                        message.data = data
                        message.replyTo = receiver(app)
                        messenger.send(message)
                    } catch (_: Exception) {
                        AgentIpc.discard(app, data)
                        pending.remove(id)?.completeExceptionally(IllegalStateException("助手请求未送达"))
                    }
                }
            } catch (_: Exception) {
                AgentIpc.discard(app, data)
                pending.remove(id)?.completeExceptionally(IllegalStateException("助手服务未能启动"))
            }
        }
        try { return result.get(timeoutMs, TimeUnit.MILLISECONDS) }
        finally { pending.remove(id) }
    }
}
