package io.timejump.chuanyue

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/** Rust-only JNI entry; no mobile plugin command or notification permission prompt. */
class GenerationService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    private fun holdWakeLock() {
        val manager = getSystemService(PowerManager::class.java) ?: return
        val held = wakeLock ?: manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "chuanyue:story-run").also {
            it.setReferenceCounted(false)
            wakeLock = it
        }
        // The native lease supplies the task's remaining deadline. A stream
        // inside a longer task must not shorten that task's platform lease.
        held.acquire((wakeUntil - android.os.SystemClock.elapsedRealtime()).coerceIn(1L, 7_205_000L))
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }
    override fun onCreate() {
        super.onCreate()
        synchronized(lock) { current = this }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        synchronized(lock) {
            try {
                val notification = notification()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
                // A short stream can finish before Android delivers this start.
                // Fulfil the foreground-start deadline, then immediately stop.
                if (!requested) stopGeneration() else holdWakeLock()
            } catch (error: Exception) {
                // Includes ForegroundServiceStartNotAllowedException,
                // SecurityException and invalid/missing foreground-service type.
                warn("promotion", error)
                try {
                    stopNativeRuns()
                } finally {
                    stopGeneration()
                }
            }
        }
        // A restarted process has no Rust streams to keep alive.
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        // Android 15+ dataSync time budget: stop promptly to avoid an ANR.
        Log.w(TAG, "Generation foreground service time budget exhausted")
        synchronized(lock) {
            try {
                stopNativeRuns()
            } finally {
                stopGeneration()
            }
        }
    }

    override fun onDestroy() {
        synchronized(lock) {
            releaseWakeLock()
            // An unexpected service destruction must not leave the Rust run
            // waiting without its foreground/wake-lock protection.
            if (current === this && requested) stopNativeRuns()
            if (current === this) current = null
        }
        super.onDestroy()
    }

    private fun stopGeneration() {
        releaseWakeLock()
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (error: Exception) {
            warn("notification removal", error)
        } finally {
            // A new lease must start the service again rather than refreshing
            // this instance after stopSelf has already been requested.
            if (current === this) {
                current = null
                requested = false
            }
            stopSelf()
        }
    }

    /** R29-T006: the story's name, the phase, words so far, a running timer and 停止. */
    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        val detailed = prefs(this).getBoolean(PREF_PROGRESS, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "生成进度", NotificationManager.IMPORTANCE_LOW).apply {
                    setSound(null, null)
                    enableVibration(false)
                    setShowBadge(false)
                }
            )
        }
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getBroadcast(
            this,
            REQUEST_STOP,
            Intent(this, GenerationActionReceiver::class.java).setAction(GenerationActionReceiver.ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val title = if (detailed && storyTitle.isNotBlank()) "《$storyTitle》" else "穿越小说模拟"
        val text = if (!detailed) "正在写下一段…" else when (phase) {
            "writing" -> if (chars > 0) "正在写 · 已写 $chars 字" else "正在写…"
            "organizing" -> "正在整理这一段…"
            "checking" -> "正在对照原著…"
            else -> "正在构思下一段…"
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        builder
            .setSmallIcon(R.drawable.ic_stat_seal)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp)
            .setWhen(if (startedAt > 0) startedAt else System.currentTimeMillis())
            .setShowWhen(true)
            .setUsesChronometer(true)
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stat_seal), "停止", stop).build())
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setSound(null)
        if (detailed && phase != "writing") builder.setProgress(0, 0, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        return builder.build()
    }

    companion object {
        private const val TAG = "GenerationService"
        private const val CHANNEL_ID = "generation"
        private const val NOTIFICATION_ID = 1001
        /** Default importance so it shows in the drawer and on the lock screen (the progress channel is silent). */
        private const val DONE_CHANNEL_ID = "story_ready"
        private const val DONE_NOTIFICATION_ID = 1002
        /** "没写完": a run stopped without a passage while the player was away. */
        private const val ISSUE_CHANNEL_ID = "story_issue"
        private const val GROUP_STORIES = "io.timejump.chuanyue.stories"
        private const val REQUEST_STOP = 7
        const val EXTRA_WORLD = "io.timejump.chuanyue.WORLD"
        const val EXTRA_ACTION = "io.timejump.chuanyue.ACTION"
        private const val PREFS = "notify"
        const val PREF_PROGRESS = "progress"
        const val PREF_EXCERPT = "excerpt"
        const val PREF_LOCKSCREEN = "lockscreen"
        /** What the progress notification shows (R29-T006), set from the Rust engine. */
        private var phase = "thinking"
        private var storyTitle = ""
        private var chars = 0
        private var startedAt = 0L
        /** Notification ids of "写好了" and "没写完", cleared when the player comes back. */
        private val shown = LinkedHashSet<Int>()

        fun prefs(context: Context): SharedPreferences = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        /** The Rust whole-run lease covers model gaps and settlement. */
        private const val STOP_DELAY_MS = 0L
        @JvmStatic private external fun nativeTimeout()
        private val lock = Any()
        private val main = Handler(Looper.getMainLooper())
        private var requested = false
        private var wakeUntil = 0L
        private var current: GenerationService? = null
        private var pendingStop: Runnable? = null
        private val committed = LinkedHashSet<String>()

        private fun stopNativeRuns() {
            try {
                nativeTimeout()
            } catch (error: LinkageError) {
                // Still release the Android service if native initialization
                // failed. Never let a missing JNI entry turn timeout into ANR.
                Log.w(TAG, "Generation native cancellation unavailable: ${error.javaClass.simpleName}")
            }
        }

        /** Called only after the selected passage was saved, never by the stream timer. */
        fun storyCommitted(context: Context, completionId: String, worldId: String = "", title: String = "", excerpt: String = "") {
            synchronized(lock) {
                if (!committed.add(completionId)) return
                if (committed.size > 256) committed.remove(committed.first())
                if (inBackground()) notifyReady(context.applicationContext, worldId, title, excerpt)
            }
        }

        /** The engine's phase and words so far; refreshes the live notification. */
        @JvmStatic
        fun update(context: Context, newPhase: String, title: String, written: Int) {
            synchronized(lock) {
                phase = newPhase
                if (title.isNotBlank()) storyTitle = title
                chars = written
                val service = current ?: return
                if (!prefs(context).getBoolean(PREF_PROGRESS, true)) return
                try {
                    service.getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, service.notification())
                } catch (error: Exception) {
                    warn("progress update", error)
                }
            }
        }

        /** A run stopped without a passage. Shown only while the player is away, never for their own 停止. */
        @JvmStatic
        fun storyIssue(context: Context, worldId: String, title: String, status: String, line: String) {
            if (status == "cancelled" || !inBackground()) return
            val app = context.applicationContext
            try {
                val manager = app.getSystemService(NotificationManager::class.java) ?: return
                if (!manager.areNotificationsEnabled()) return
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    manager.createNotificationChannel(
                        NotificationChannel(ISSUE_CHANNEL_ID, "没写完提醒", NotificationManager.IMPORTANCE_DEFAULT).apply {
                            description = "切到后台时，一段没写完会提醒你回来接着写"
                        }
                    )
                }
                val id = storyNotificationId(worldId, 1)
                val resume = storyIntent(app, worldId, "resume", id)
                val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(app, ISSUE_CHANNEL_ID) else Notification.Builder(app)
                builder.setSmallIcon(R.drawable.ic_stat_seal)
                    .setContentTitle(if (title.isNotBlank()) "《$title》没写完" else "这一段没写完")
                    .setContentText(line)
                    .setContentIntent(resume)
                    .addAction(Notification.Action.Builder(Icon.createWithResource(app, R.drawable.ic_stat_seal), "接着写完", resume).build())
                    .setAutoCancel(true)
                    .setGroup(GROUP_STORIES)
                    .setCategory(Notification.CATEGORY_ERROR)
                synchronized(lock) { shown.add(id) }
                manager.notify(id, builder.build())
            } catch (error: Exception) {
                warn("issue notification", error)
            }
        }

        /** Stop from the notification: the same as a timeout, progress is kept. */
        @JvmStatic
        fun stopFromNotification() {
            synchronized(lock) { stopNativeRuns() }
        }

        /** One notification per story and kind, so two stories never replace each other. */
        private fun storyNotificationId(worldId: String, kind: Int): Int =
            if (worldId.isBlank()) DONE_NOTIFICATION_ID + kind else 2000 + ((worldId.hashCode() and 0x3fffffff) % 100000) * 2 + kind

        /** Opens the app on that story; `action` "resume" asks it to finish the passage. */
        private fun storyIntent(context: Context, worldId: String, action: String, request: Int): PendingIntent =
            PendingIntent.getActivity(
                context, request,
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(EXTRA_WORLD, worldId)
                    .putExtra(EXTRA_ACTION, action),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

        /** True when the app is not on screen; then a finished passage is worth a notification. */
        private fun inBackground(): Boolean {
            val state = ActivityManager.RunningAppProcessInfo()
            ActivityManager.getMyMemoryState(state)
            return state.importance > ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        }

        /** "写好了" when a passage finished while the player was away (ANDROID_COMPAT F2): the story, its first line, straight back to it. */
        private fun notifyReady(context: Context, worldId: String, title: String, excerpt: String) {
            try {
                val manager = context.getSystemService(NotificationManager::class.java) ?: return
                if (!manager.areNotificationsEnabled()) return
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    manager.createNotificationChannel(
                        NotificationChannel(DONE_CHANNEL_ID, "写好了提醒", NotificationManager.IMPORTANCE_DEFAULT).apply {
                            description = "切到后台时，下一段写好会提醒你"
                        }
                    )
                }
                val id = storyNotificationId(worldId, 0)
                val open = storyIntent(context, worldId, "read", id)
                val settings = prefs(context)
                val line = if (settings.getBoolean(PREF_EXCERPT, true) && excerpt.isNotBlank()) excerpt else "下一段写好了，回来看看"
                val heading = if (title.isNotBlank()) "《$title》写好了" else "穿越小说模拟"
                val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, DONE_CHANNEL_ID) else Notification.Builder(context)
                // The lock screen shows the story's name only, unless the player allowed the line too.
                val lockVersion = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, DONE_CHANNEL_ID) else Notification.Builder(context))
                    .setSmallIcon(R.drawable.ic_stat_seal)
                    .setContentTitle(heading)
                    .setContentText("下一段写好了")
                    .build()
                builder.setSmallIcon(R.drawable.ic_stat_seal)
                    .setContentTitle(heading)
                    .setContentText(line)
                    .setStyle(Notification.BigTextStyle().bigText(line))
                    .setContentIntent(open)
                    .addAction(Notification.Action.Builder(Icon.createWithResource(context, R.drawable.ic_stat_seal), "继续读", open).build())
                    .setAutoCancel(true)
                    .setGroup(GROUP_STORIES)
                    .setCategory(Notification.CATEGORY_STATUS)
                    .setVisibility(if (settings.getBoolean(PREF_LOCKSCREEN, false)) Notification.VISIBILITY_PUBLIC else Notification.VISIBILITY_PRIVATE)
                    .setPublicVersion(lockVersion)
                synchronized(lock) { shown.add(id) }
                manager.notify(id, builder.build())
            } catch (error: Exception) {
                warn("ready notification", error)
            }
        }

        /** Clears "写好了" and "没写完" once the player is back. */
        @JvmStatic
        fun clearReady(context: Context) {
            try {
                val manager = context.getSystemService(NotificationManager::class.java) ?: return
                manager.cancel(DONE_NOTIFICATION_ID)
                val ids = synchronized(lock) { shown.toList().also { shown.clear() } }
                for (id in ids) manager.cancel(id)
            } catch (error: Exception) {
                warn("ready notification removal", error)
            }
        }

        private fun warn(operation: String, error: Exception) {
            // Log the failure class only; never include platform exception text.
            Log.w(TAG, "Generation foreground service $operation failed: ${error.javaClass.simpleName}")
        }

        @JvmStatic
        fun start(context: Context, remainingMs: Long) {
            synchronized(lock) {
                val deadline = android.os.SystemClock.elapsedRealtime() + remainingMs.coerceIn(1L, 7_205_000L)
                wakeUntil = if (requested) maxOf(wakeUntil, deadline) else deadline
                pendingStop?.let { main.removeCallbacks(it) }
                pendingStop = null
                // Already up (a second request of the same turn): nothing to start.
                if (requested && current != null) {
                    current?.holdWakeLock()
                    return
                }
                requested = true
                phase = "thinking"
                chars = 0
                storyTitle = ""
                startedAt = System.currentTimeMillis()
                try {
                    val app = context.applicationContext
                    val intent = Intent(app, GenerationService::class.java)
                    // POST_NOTIFICATIONS is deliberately not checked: denial
                    // hides the drawer notification but does not prohibit FGS.
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        app.startForegroundService(intent)
                    } else {
                        app.startService(intent)
                    }
                } catch (error: Exception) {
                    requested = false
                    warn("start", error)
                    stopNativeRuns()
                }
            }
        }

        @JvmStatic
        fun stop(context: Context) {
            synchronized(lock) {
                pendingStop?.let { main.removeCallbacks(it) }
                val stop = Runnable {
                    synchronized(lock) {
                        pendingStop = null
                        requested = false
                        try {
                            // If onCreate has not run, onStartCommand observes false
                            // and stops after promotion. Never start a service to stop it.
                            current?.stopGeneration()
                        } catch (error: Exception) {
                            warn("stop", error)
                        }
                    }
                }
                pendingStop = stop
                main.postDelayed(stop, STOP_DELAY_MS)
            }
        }
    }
}
