package io.timejump.chuanyue

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.os.Process
import io.timejump.pi.NodeRuntime
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Node, Rust and task lifetime belong to :agent, independently of the WebView. */
class AgentHostService : Service(), AgentNative.Sink {
    private data class Request(val id: Long, val payload: String, val client: Messenger, val dispatched: AtomicBoolean = AtomicBoolean(false))
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newFixedThreadPool(2)
    private val control = Executors.newSingleThreadExecutor()
    private val booted = AtomicBoolean(false)
    private val destroying = AtomicBoolean(false)
    private val requests = ConcurrentHashMap<Long, Request>()
    private val clients = ConcurrentHashMap<IBinder, Messenger>()
    private val internalIds = AtomicLong(1L shl 61)
    @Volatile private var handle = 0L
    @Volatile private var failed = false
    @Volatile private var active = false
    @Volatile private var nodeEnded = false
    @Volatile private var cleanupConfirmed = false
    private var activeTask: String? = null
    private var activeAttempt: String? = null
    private var nodeThread: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val timeout = Runnable { stopForSystemTimeout() }
    private val prepareTimeout = Runnable { if (!active) idle() }

    private val messenger = Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(message: Message) {
            if (message.what != AgentIpc.COMMAND) return
            val id = message.data.getLong("id")
            val client = message.replyTo ?: return
            if (id <= 0 || requests.size >= 64) { send(client, id, failure("agent_busy", "助手请求较多，请稍后重试")); return }
            val data = Bundle(message.data)
            val inline = data.getString("json")
            val isControl = try { inline != null && JSONObject(inline).optString("op") in setOf("stop", "force_stop_attempt", "retire_host") } catch (_: Exception) { false }
            (if (isControl) control else worker).execute {
                try {
                    val payload = AgentIpc.read(this@AgentHostService, data)
                    val command=JSONObject(payload)
                    if (command.optString("op")=="retire_host") {
                        main.post {
                            if(active) send(client,id,failure("agent_busy","助手仍在收尾，未退出服务"))
                            else {send(client,id,JSONObject().put("ok",true).put("data",JSONObject().put("retired",true)).toString());idle();terminateDedicatedProcess()}
                        }
                        return@execute
                    }
                    if (command.optString("op")=="force_stop_attempt") {
                        main.post {
                            val matched=command.optString("taskId")==activeTask && command.optString("attemptId")==activeAttempt
                            send(client,id,JSONObject().put("ok",true).put("data",JSONObject().put("matched",matched)).toString())
                            if (matched) { idle(); terminateDedicatedProcess() }
                        }
                        return@execute
                    }
                    val request = Request(id, payload, client)
                    if (requests.putIfAbsent(id, request) != null) {
                        send(client, id, failure("duplicate_request", "助手请求标识重复")); return@execute
                    }
                    clients[client.binder] = client
                    dispatchIfReady(request)
                } catch (_: Exception) { send(client, id, failure("invalid_request", "助手请求读取失败")) }
            }
        }
    })

    override fun onCreate() {
        super.onCreate()
        // These are service-context JNI callbacks, never Activity/Wry handles.
        worker.execute { bootstrap() }
    }
    override fun onBind(intent: Intent?): IBinder = messenger.binder
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == PREPARE_RUN) {
            promote()
            main.removeCallbacks(prepareTimeout)
            main.postDelayed(prepareTimeout, 90_000)
        }
        return START_NOT_STICKY
    }
    private fun dispatchIfReady(request: Request) {
        val current = handle
        if (failed) {
            requests.remove(request.id)
            send(request.client, request.id, failure("agent_host_unavailable", "助手宿主未能启动，尚未执行任务"))
        } else if (current != 0L && booted.get()) {
            if (!request.dispatched.compareAndSet(false, true)) return
            try { AgentNative.nativeDispatch(current, request.id, "agent", request.payload) }
            catch (_: Throwable) {
                requests.remove(request.id)
                send(request.client, request.id, failure("agent_dispatch_failed", "助手请求未能送达"))
            }
        }
    }
    private fun bootstrap() {
        var nodeFd = -1
        try {
            AgentNative.install(this)
            val runtime = extractRuntime()
            val dataRoot = File(applicationInfo.dataDir).canonicalFile
            val working = File(dataRoot, "pi-host").also { check(it.mkdirs() || it.isDirectory) }
            val descriptors = NodeRuntime.createBridge()
            check(descriptors.size == 2)
            nodeFd = descriptors[1]
            // Rust takes descriptors[0] exactly once, including failure paths.
            val current = AgentNative.nativeInitialize(applicationContext, dataRoot.path, runtime.path, descriptors[0])
            check(current != 0L)
            handle = current
            val ownedNodeFd = nodeFd
            nodeFd = -1
            nodeThread = Thread({
                val exit = try { NodeRuntime.run(File(runtime, "host/src/entry.mjs").path, working.path, ownedNodeFd) }
                    catch (_: Throwable) { -1 }
                nodeEnded = true
                val cleaned = try { AgentNative.nativeRuntimeExited(current, exit) } catch (_: Throwable) { false }
                if (cleaned) cleanupConfirmed = true
                main.post {
                    if (!destroying.get()) {
                        failed = true
                        failPending(if (cleanupConfirmed) "助手宿主已退出，已保留任务进度" else "助手服务收尾尚未确认，任务需检查后恢复")
                        idle()
                        // Only this dedicated process must be fresh after V8
                        // teardown. Never force-stop the package or its UI.
                        if (cleanupConfirmed) terminateDedicatedProcess()
                    }
                }
            }, "pi-agent-node").also { it.start() }
            booted.set(true)
            requests.values.toList().forEach { dispatchIfReady(it) }
        } catch (_: Throwable) {
            failed = true
            if (nodeFd >= 0) try { ParcelFileDescriptor.adoptFd(nodeFd).close() } catch (_: Exception) { }
            failPending("助手宿主资源未准备好，尚未执行任务")
            main.post { idle() }
        }
    }
    private fun extractRuntime(): File {
        val manifest = assets.open("pi-runtime/manifest.json").use { it.readBytes() }
        check(manifest.size <= 2 * 1024 * 1024)
        val version = MessageDigest.getInstance("SHA-256").digest(manifest).joinToString("") { "%02x".format(it) }
        val root = File(noBackupFilesDir, "pi-runtime").also { check(it.mkdirs() || it.isDirectory) }.canonicalFile
        val runtime = File(root, version)
        if (!File(runtime, "manifest.json").isFile) {
            check(runtime.mkdirs() || runtime.isDirectory)
            fun copy(asset: String, destination: File) {
                val children = assets.list(asset) ?: emptyArray()
                if (children.isNotEmpty()) {
                    check(destination.mkdirs() || destination.isDirectory)
                    children.forEach { child -> if (asset != "pi-runtime" || child != "manifest.json") copy("$asset/$child", File(destination, child)) }
                } else {
                    check(destination.parentFile?.let { it.mkdirs() || it.isDirectory } == true)
                    assets.open(asset).use { input -> FileOutputStream(destination).use { output -> input.copyTo(output); output.fd.sync() } }
                }
            }
            copy("pi-runtime", runtime)
            // Marker is an actual signed asset, not an unlisted extra file.
            FileOutputStream(File(runtime, "manifest.json")).use { it.write(manifest); it.fd.sync() }
        }
        check(runtime.canonicalFile.parentFile == root)
        // JNI performs the full shared native manifest validation before Node.
        return runtime.canonicalFile
    }
    override fun reply(handle: Long, requestId: Long, response: String) {
        if (handle != this.handle) return
        if (requestId == 0L) {
            val notice = try { JSONObject(response) } catch (_: Exception) { null }
            if (notice?.optString("event")=="execution_started") {
                val task=notice.optString("taskId");val attempt=notice.optString("attemptId")
                main.post {activeTask=task;activeAttempt=attempt}
                return
            }
            if (notice?.optString("event") == "stop_timeout") {
                val task = notice.optString("taskId")
                val attempt = notice.optString("attemptId")
                main.post {
                    if (task == activeTask && attempt == activeAttempt) {
                        idle()
                        // Rust has already fenced and settled this attempt.
                        // Fresh service bootstrap must use a new V8 process.
                        try { NodeRuntime.abortRuntime() } catch (_: Throwable) { }
                        terminateDedicatedProcess()
                    }
                }
                return
            }
            val cleanup = try { JSONObject(response).optString("event") == "host_cleanup_confirmed" } catch (_: Exception) { false }
            if (cleanup) {
                cleanupConfirmed = true
                main.post {
                    if (destroying.get() || (failed && nodeEnded)) {
                        AgentNative.remove(this)
                        terminateDedicatedProcess()
                    }
                }
                return
            }
        }
        if (destroying.get()) return
        if (requestId == 0L) {
            clients.values.forEach { send(it, 0, response) }
            return
        }
        val request = requests.remove(requestId) ?: return
        try {
            val parsed = JSONObject(response)
            val data = parsed.optJSONObject("data")
            if (JSONObject(request.payload).optString("op") in setOf("start", "continue")) {
                data?.optString("taskId")?.takeIf { it.isNotEmpty() }?.let { main.post { activeTask = it; activeAttempt = data?.optString("attemptId") } }
            }
        } catch (_: Exception) { }
        send(request.client, requestId, response)
    }
    override fun activity(handle: Long, active: Boolean) {
        if (handle != this.handle || destroying.get()) return
        main.post {
            this.active = active
            if (active) {
                main.removeCallbacks(prepareTimeout)
                promote()
                val manager = getSystemService(PowerManager::class.java)
                val lock = wakeLock ?: manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "chuanyue:pi-agent").also {
                    it.setReferenceCounted(false); wakeLock = it
                }
                lock.acquire(MAX_ACTIVE_MS + 5_000)
                main.removeCallbacks(timeout)
                main.postDelayed(timeout, MAX_ACTIVE_MS)
            } else {
                idle()
            }
        }
    }
    private fun promote() {
        try {
            val manager = getSystemService(NotificationManager::class.java)
            if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("agent_execution", "助手进度", NotificationManager.IMPORTANCE_LOW).apply {
                setSound(null, null); enableVibration(false); setShowBadge(false)
            })
            val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "agent_execution") else Notification.Builder(this)
            val notification = builder.setSmallIcon(R.drawable.ic_stat_seal).setContentTitle("穿越小说模拟").setContentText("助手正在处理本局任务…")
                .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_PROGRESS).build()
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else startForeground(NOTIFICATION_ID, notification)
        } catch (_: Exception) { stopForSystemTimeout() }
    }
    private fun idle() {
        main.removeCallbacks(timeout)
        main.removeCallbacks(prepareTimeout)
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        // Keep the bound service and Node transport available for another task.
    }
    private fun stopForSystemTimeout() {
        main.removeCallbacks(timeout)
        val current = handle
        val task = activeTask
        worker.execute {
            try {
                if (current != 0L && task != null) AgentNative.nativeDispatch(current, internalIds.getAndIncrement(), "agent", JSONObject().put("op", "stop").put("taskId", task).put("attemptId", activeAttempt).put("requestId", "system-${internalIds.getAndIncrement()}").toString())
                else NodeRuntime.abortRuntime()
            } catch (_: Throwable) { try { NodeRuntime.abortRuntime() } catch (_: Throwable) { } }
        }
        // Android's timeout callback must return promptly. Rust's stop marker,
        // cancellation and task ledger remain the authoritative recovery path.
        idle()
    }
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopForSystemTimeout()
        // Android's dataSync allowance is cumulative. Removing foreground
        // status alone does not satisfy its timeout contract for a started
        // service; a bound connection may still finish native cancellation.
        stopSelf(startId)
    }
    private fun send(client: Messenger, id: Long, response: String) {
        val bundle = Bundle().apply { putLong("id", id) }
        try {
            AgentIpc.put(this, bundle, response)
            client.send(Message.obtain(null, AgentIpc.REPLY).apply { data = bundle })
        } catch (_: Exception) { AgentIpc.discard(this, bundle); clients.remove(client.binder) }
    }
    private fun failPending(message: String) {
        requests.values.toList().forEach { request ->
            if (requests.remove(request.id) != null) send(request.client, request.id, failure("agent_host_closed", message))
        }
    }
    private fun terminateDedicatedProcess() {
        val manager = getSystemService(ActivityManager::class.java)
        val name = manager.runningAppProcesses?.firstOrNull { it.pid == Process.myPid() }?.processName
        if (name == "$packageName:agent") Process.killProcess(Process.myPid())
    }
    override fun onDestroy() {
        if (destroying.compareAndSet(false, true)) {
            idle()
            failPending("助手服务已结束，进度已保留")
            val current = handle
            Thread({
                val cleaned = try { current != 0L && AgentNative.nativeShutdown(current) } catch (_: Throwable) { false }
                if (cleaned) cleanupConfirmed = true
                try { nodeThread?.join(5_000) } catch (_: InterruptedException) { }
                // V8 cannot initialize twice in a cached service process.
                if (cleanupConfirmed && (nodeThread == null || nodeEnded)) {
                    AgentNative.remove(this)
                    terminateDedicatedProcess()
                }
            }, "pi-agent-shutdown").start()
            worker.shutdown()
            control.shutdown()
        }
        super.onDestroy()
    }
    companion object {
        const val PREPARE_RUN = "io.timejump.chuanyue.agent.PREPARE_RUN"
        private const val NOTIFICATION_ID = 1003
        private const val MAX_ACTIVE_MS = 7_200_000L
        private fun failure(code: String, message: String) = JSONObject().put("ok", false).put("error", JSONObject().put("code", code).put("message", message)).toString()
    }
}
