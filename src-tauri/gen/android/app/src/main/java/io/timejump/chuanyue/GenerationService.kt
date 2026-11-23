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
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

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
            current = this
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
                warn("promotion", error)
                try {
                    if (inBackground()) stopNativeRuns()
                } finally {
                    stopGeneration()
                }
            }
        }
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
            if (current === this) {
                current = null
                requested = false
            }
            stopSelf()
        }
    }

    /** The story's name, the phase, words so far, a running timer and 停止. */
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
            Intent(this, GenerationActionReceiver::class.java).setAction(GenerationActionReceiver.ACTION_STOP)
                .setData(Uri.Builder().scheme("chuanyue").authority("generation-stop").appendPath(executionId.ifBlank { "active" }).build())
                .putExtra(GenerationActionReceiver.EXTRA_RUN_ID, runId)
                .putExtra(GenerationActionReceiver.EXTRA_EXECUTION_ID, executionId),
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
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder
            .setSmallIcon(R.drawable.ic_stat_seal)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(openApp)
            .setWhen(if (startedAt > 0) startedAt else System.currentTimeMillis())
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stat_seal), "停止", stop).build())
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
        private const val DONE_NOTIFICATION_ID = 1002
        private const val SUMMARY_NOTIFICATION_ID = 1006
        private const val TEST_NOTIFICATION_ID = 1007

        const val DONE_SOUND_CHANNEL = "story_done"
        const val ISSUE_SOUND_CHANNEL = "story_failed"
        private const val DONE_QUIET_CHANNEL = "story_done_quiet"
        private const val ISSUE_QUIET_CHANNEL = "story_failed_quiet"
        private val LEGACY_CHANNELS = listOf(
            "story_ready",
            "story_issue",
            "story_ready_sound",
            "story_issue_sound",
            "story_ready_quiet",
            "story_issue_quiet"
        )
        private const val GROUP_STORIES = "io.timejump.chuanyue.stories"
        private const val REQUEST_STOP = 7
        const val EXTRA_WORLD = "io.timejump.chuanyue.WORLD"
        const val EXTRA_ACTION = "io.timejump.chuanyue.ACTION"
        const val EXTRA_RUN = "io.timejump.chuanyue.RUN"
        private const val PREFS = "notify"
        const val PREF_PROGRESS = "progress"
        const val PREF_EXCERPT = "excerpt"
        const val PREF_LOCKSCREEN = "lockscreen"
        const val PREF_SOUND = "sound"

        /** Ensures a specific channel (`story_done` / `story_failed` or quiet variant) exists and returns its id. */
        fun ensureChannel(context: Context, issue: Boolean, sound: Boolean): String {
            val id = when {
                issue && sound -> ISSUE_SOUND_CHANNEL
                issue -> ISSUE_QUIET_CHANNEL
                sound -> DONE_SOUND_CHANNEL
                else -> DONE_QUIET_CHANNEL
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return id
            val manager = context.getSystemService(NotificationManager::class.java) ?: return id
            for (old in LEGACY_CHANNELS) {
                try { manager.deleteNotificationChannel(old) } catch (error: Exception) { warn("channel cleanup", error) }
            }
            if (manager.getNotificationChannel(id) == null) {
                val name = if (issue) "没写完提醒" else "写好了提醒"
                val channel = NotificationChannel(
                    id,
                    if (sound) name else "$name（静音）",
                    if (sound) NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_LOW
                )
                channel.description = if (issue) "切到后台时，一段没写完会弹出横幅提醒你回来接着写" else "切到后台时，下一段写好会弹出横幅并响铃提醒你"
                channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                if (sound) {
                    channel.setSound(
                        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                    channel.enableVibration(true)
                    channel.vibrationPattern = longArrayOf(0, 180, 120, 180)
                    channel.enableLights(true)
                } else {
                    channel.setSound(null, null)
                    channel.enableVibration(false)
                }
                manager.createNotificationChannel(channel)
            }
            return id
        }

        /** The channel a reminder uses now, created on first use. */
        fun reminderChannel(context: Context, issue: Boolean): String {
            val sound = prefs(context).getBoolean(PREF_SOUND, true)
            return ensureChannel(context, issue, sound)
        }

        /** Builds a heads-up + audible reminder notification with NotificationCompat. */
        private fun reminderCompatBuilder(context: Context, channel: String): NotificationCompat.Builder {
            val sound = channel == DONE_SOUND_CHANNEL || channel == ISSUE_SOUND_CHANNEL
            val builder = NotificationCompat.Builder(context, channel)
                .setSmallIcon(R.drawable.ic_stat_seal)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
            if (sound) {
                builder.setDefaults(NotificationCompat.DEFAULT_ALL)
            }
            return builder
        }

        /** Verifies IMPORTANCE_HIGH, non-empty sound URI, notifications enabled, and ringer mode not silent. */
        fun reminderAudible(context: Context): Pair<Boolean, Boolean> {
            val wanted = prefs(context).getBoolean(PREF_SOUND, true)
            val audio = context.getSystemService(AudioManager::class.java)
            val ringerNotSilent = audio == null || audio.ringerMode != AudioManager.RINGER_MODE_SILENT
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return wanted to (wanted && ringerNotSilent)
            val manager = context.getSystemService(NotificationManager::class.java) ?: return wanted to (wanted && ringerNotSilent)
            if (!manager.areNotificationsEnabled()) return wanted to false
            if (!wanted) return false to false
            val channelsOk = listOf(false, true).all { issue ->
                val id = ensureChannel(context, issue = issue, sound = true)
                val channel = manager.getNotificationChannel(id)
                channel != null &&
                    channel.importance >= NotificationManager.IMPORTANCE_HIGH &&
                    channel.sound != null &&
                    channel.sound.toString().isNotEmpty()
            }
            return wanted to (channelsOk && ringerNotSilent)
        }

        /** Minimum importance across the active reminder channels (`story_done` and `story_failed`). */
        fun channelStatus(context: Context): Pair<Int, Boolean> {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                return NotificationManager.IMPORTANCE_HIGH to true
            }
            val manager = context.getSystemService(NotificationManager::class.java)
                ?: return NotificationManager.IMPORTANCE_HIGH to true
            val enabled = manager.areNotificationsEnabled()
            val importances = listOf(false, true).map { issue ->
                val id = ensureChannel(context, issue = issue, sound = true)
                manager.getNotificationChannel(id)?.importance ?: NotificationManager.IMPORTANCE_HIGH
            }
            val minImportance = importances.minOrNull() ?: NotificationManager.IMPORTANCE_HIGH
            val canFloat = enabled && minImportance >= NotificationManager.IMPORTANCE_HIGH
            return minImportance to canFloat
        }

        /** Which reminder channel to open in settings: the degraded one when one is muted/demoted, otherwise `story_done`. */
        fun mutedReminderChannel(context: Context): String {
            val doneId = ensureChannel(context, issue = false, sound = true)
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return doneId
            val manager = context.getSystemService(NotificationManager::class.java) ?: return doneId
            val isHealthy = { id: String ->
                val channel = manager.getNotificationChannel(id)
                channel != null &&
                    channel.importance >= NotificationManager.IMPORTANCE_HIGH &&
                    channel.sound != null &&
                    channel.sound.toString().isNotEmpty()
            }
            if (!isHealthy(doneId)) return doneId
            val issueId = ensureChannel(context, issue = true, sound = true)
            return if (!isHealthy(issueId)) issueId else doneId
        }

        /** 试一下提醒: one "写好了"-style reminder now with heads-up banner, BigTextStyle and content PendingIntent. */
        fun testReminder(context: Context) {
            val app = context.applicationContext
            try {
                val manager = app.getSystemService(NotificationManager::class.java) ?: return
                val channel = reminderChannel(app, issue = false)
                val openApp = PendingIntent.getActivity(
                    app,
                    TEST_NOTIFICATION_ID,
                    Intent(app, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val body = "以后切到后台时写好一段，会像这样弹出横幅并响提示音提醒你。"
                val builder = reminderCompatBuilder(app, channel)
                    .setContentTitle("试一下：写好了提醒")
                    .setContentText(body)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                    .setContentIntent(openApp)
                manager.notify(TEST_NOTIFICATION_ID, builder.build())
            } catch (error: Exception) {
                warn("test reminder", error)
            }
        }

        private var phase = "thinking"
        private var storyTitle = ""
        private var runId = ""
        private var executionId = ""
        private var chars = 0
        private var startedAt = 0L
        private data class Progress(val run: String, val execution: String, val phase: String, val title: String, val chars: Int)
        private val progress = LinkedHashMap<String, Progress>()
        private val finished = LinkedHashSet<String>()
        /** Notification ids of "写好了" and "没写完", cleared when the player comes back. */
        private val shown = LinkedHashSet<Int>()

        fun prefs(context: Context): SharedPreferences = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        private const val STOP_DELAY_MS = 0L
        @JvmStatic private external fun nativeTimeout()
        @JvmStatic private external fun nativeStop(runId: String, executionId: String)
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
                Log.w(TAG, "Generation native cancellation unavailable: ${error.javaClass.simpleName}")
            }
        }

        /** Posts a group summary when 2+ completion/issue notifications are active so children keep their banner. */
        private fun postSummaryIfNeeded(context: Context, manager: NotificationManager, channel: String) {
            val activeCount = synchronized(lock) { shown.size }
            if (activeCount < 2) return
            val openApp = PendingIntent.getActivity(
                context,
                SUMMARY_NOTIFICATION_ID,
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val summaryLine = "$activeCount 个故事有新进展，点开查看。"
            val summary = NotificationCompat.Builder(context, channel)
                .setSmallIcon(R.drawable.ic_stat_seal)
                .setContentTitle("穿越小说模拟")
                .setContentText(summaryLine)
                .setStyle(NotificationCompat.BigTextStyle().bigText(summaryLine))
                .setContentIntent(openApp)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setGroup(GROUP_STORIES)
                .setGroupSummary(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .build()
            manager.notify(SUMMARY_NOTIFICATION_ID, summary)
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
        fun update(context: Context, run: String, execution: String, newPhase: String, title: String, written: Int) {
            synchronized(lock) {
                if (execution.isBlank() || finished.contains(execution)) return
                progress.remove(run)
                progress[run] = Progress(run, execution, newPhase, title, written)
                refreshProgress(context)
            }
        }

        @JvmStatic
        fun finishProgress(context: Context, run: String, execution: String) {
            synchronized(lock) {
                if (finished.add(execution) && finished.size > 256) finished.remove(finished.first())
                if (progress[run]?.execution == execution) {
                    progress.remove(run)
                    refreshProgress(context)
                }
            }
        }

        private fun refreshProgress(context: Context) {
            val previousRun = runId
            val previousExecution = executionId
            val target = progress.values.lastOrNull()
            runId = target?.run.orEmpty()
            executionId = target?.execution.orEmpty()
            phase = target?.phase ?: "thinking"
            storyTitle = target?.title.orEmpty()
            chars = target?.chars ?: 0
            val service = current ?: return
            val targetChanged = runId != previousRun || executionId != previousExecution
            if (!targetChanged && !prefs(context).getBoolean(PREF_PROGRESS, true)) return
            try {
                service.getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, service.notification())
            } catch (error: Exception) {
                warn("progress update", error)
            }
        }

        /** A run stopped without a passage. Shown only while the player is away, never for their own 停止. */
        @JvmStatic
        fun storyIssue(context: Context, worldId: String, title: String, status: String, line: String, run: String) {
            if (status == "cancelled" || !inBackground()) return
            val app = context.applicationContext
            try {
                val manager = app.getSystemService(NotificationManager::class.java) ?: return
                if (!manager.areNotificationsEnabled()) return
                val channel = reminderChannel(app, issue = true)
                val id = storyNotificationId(worldId, 1)
                val resume = storyIntent(app, worldId, "resume", id, run)
                val body = line.ifBlank { "切回来可以接着写完。" }
                val builder = reminderCompatBuilder(app, channel)
                    .setContentTitle(if (title.isNotBlank()) "《$title》没写完" else "这一段没写完")
                    .setContentText(body)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                    .setContentIntent(resume)
                    .addAction(R.drawable.ic_stat_seal, "接着写完", resume)
                    .setGroup(GROUP_STORIES)
                    .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                synchronized(lock) { shown.add(id) }
                manager.notify(id, builder.build())
                postSummaryIfNeeded(app, manager, channel)
            } catch (error: Exception) {
                warn("issue notification", error)
            }
        }

        /** Stop only the launch represented by this immutable notification. */
        @JvmStatic
        fun stopFromNotification(run: String, execution: String) {
            val target = synchronized(lock) {
                if (run.isNotBlank() && execution.isNotBlank()) run to execution
                else progress.values.lastOrNull()?.let { it.run to it.execution }
            } ?: return
            if (target.first.isBlank() || target.second.isBlank()) return
            try { nativeStop(target.first, target.second) }
            catch (error: LinkageError) { Log.w(TAG, "Generation targeted cancellation unavailable: ${error.javaClass.simpleName}") }
        }

        private fun storyNotificationId(worldId: String, kind: Int): Int =
            if (worldId.isBlank()) DONE_NOTIFICATION_ID + kind else 2000 + ((worldId.hashCode() and 0x3fffffff) % 100000) * 2 + kind

        private fun storyIntent(context: Context, worldId: String, action: String, request: Int, run: String = ""): PendingIntent =
            PendingIntent.getActivity(
                context, request,
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(EXTRA_WORLD, worldId)
                    .putExtra(EXTRA_ACTION, action)
                    .putExtra(EXTRA_RUN, run),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

        private fun inBackground(): Boolean {
            val state = ActivityManager.RunningAppProcessInfo()
            ActivityManager.getMyMemoryState(state)
            return state.importance > ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        }

        /** "写好了" when a passage finished while the player was away: heads-up banner, BigTextStyle and direct deep link. */
        private fun notifyReady(context: Context, worldId: String, title: String, excerpt: String) {
            try {
                val manager = context.getSystemService(NotificationManager::class.java) ?: return
                if (!manager.areNotificationsEnabled()) return
                val channel = reminderChannel(context, issue = false)
                val id = storyNotificationId(worldId, 0)
                val open = storyIntent(context, worldId, "read", id)
                val settings = prefs(context)
                val line = if (settings.getBoolean(PREF_EXCERPT, true) && excerpt.isNotBlank()) excerpt else "下一段写好了，回来看看"
                val heading = if (title.isNotBlank()) "《$title》写好了" else "穿越小说模拟"
                val builder = reminderCompatBuilder(context, channel)
                    .setContentTitle(heading)
                    .setContentText(line)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(line))
                    .setContentIntent(open)
                    .addAction(R.drawable.ic_stat_seal, "继续读", open)
                    .setGroup(GROUP_STORIES)
                    .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                synchronized(lock) { shown.add(id) }
                manager.notify(id, builder.build())
                postSummaryIfNeeded(context, manager, channel)
            } catch (error: Exception) {
                warn("ready notification", error)
            }
        }

        /** Clears "写好了", "没写完", and group summary once the player is back. */
        @JvmStatic
        fun clearReady(context: Context) {
            try {
                val manager = context.getSystemService(NotificationManager::class.java) ?: return
                manager.cancel(DONE_NOTIFICATION_ID)
                manager.cancel(SUMMARY_NOTIFICATION_ID)
                val ids = synchronized(lock) { shown.toList().also { shown.clear() } }
                for (id in ids) manager.cancel(id)
            } catch (error: Exception) {
                warn("ready notification removal", error)
            }
        }

        private fun warn(operation: String, error: Exception) {
            Log.w(TAG, "Generation foreground service $operation failed: ${error.javaClass.simpleName}")
        }

        @JvmStatic
        fun start(context: Context, remainingMs: Long) {
            synchronized(lock) {
                val deadline = android.os.SystemClock.elapsedRealtime() + remainingMs.coerceIn(1L, 7_205_000L)
                wakeUntil = if (requested) maxOf(wakeUntil, deadline) else deadline
                pendingStop?.let { main.removeCallbacks(it) }
                pendingStop = null
                if (requested && current != null) {
                    current?.holdWakeLock()
                    return
                }
                requested = true
                val target = progress.values.lastOrNull()
                phase = target?.phase ?: "thinking"
                chars = target?.chars ?: 0
                storyTitle = target?.title.orEmpty()
                runId = target?.run.orEmpty()
                executionId = target?.execution.orEmpty()
                startedAt = System.currentTimeMillis()
                try {
                    val app = context.applicationContext
                    val intent = Intent(app, GenerationService::class.java)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        app.startForegroundService(intent)
                    } else {
                        app.startService(intent)
                    }
                } catch (error: Exception) {
                    requested = false
                    warn("start", error)
                    if (inBackground()) stopNativeRuns()
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
