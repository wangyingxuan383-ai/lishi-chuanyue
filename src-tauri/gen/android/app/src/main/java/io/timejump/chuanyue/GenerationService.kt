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
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/** Rust-only JNI entry; no mobile plugin command or notification permission prompt. */
class GenerationService : Service() {
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
                if (!requested) stopGeneration()
            } catch (error: Exception) {
                // Includes ForegroundServiceStartNotAllowedException,
                // SecurityException and invalid/missing foreground-service type.
                warn("promotion", error)
                stopGeneration()
            }
        }
        // A restarted process has no Rust streams to keep alive.
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        // Android 15+ dataSync time budget: stop promptly to avoid an ANR.
        Log.w(TAG, "Generation foreground service time budget exhausted")
        synchronized(lock) { stopGeneration() }
    }

    override fun onDestroy() {
        synchronized(lock) {
            if (current === this) current = null
        }
        super.onDestroy()
    }

    private fun stopGeneration() {
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (error: Exception) {
            warn("notification removal", error)
        } finally {
            stopSelf()
        }
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
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
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        builder
            .setSmallIcon(R.drawable.ic_stat_seal)
            .setContentTitle("历史穿越")
            .setContentText("正在写下一段…")
            .setContentIntent(openApp)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setSound(null)
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
        /**
         * A turn can make two requests (the story, then a short record fill-in);
         * the service stays up a little after one ends so the second is still
         * covered in the background (ANDROID_COMPAT F3).
         */
        private const val STOP_DELAY_MS = 8000L
        private val lock = Any()
        private val main = Handler(Looper.getMainLooper())
        private var requested = false
        private var current: GenerationService? = null
        private var pendingStop: Runnable? = null
        private val committed = LinkedHashSet<String>()

        /** Called only after the selected passage was saved, never by the stream timer. */
        fun storyCommitted(context: Context, completionId: String) {
            synchronized(lock) {
                if (!committed.add(completionId)) return
                if (committed.size > 256) committed.remove(committed.first())
                if (inBackground()) notifyReady(context.applicationContext)
            }
        }

        /** True when the app is not on screen; then a finished passage is worth a notification. */
        private fun inBackground(): Boolean {
            val state = ActivityManager.RunningAppProcessInfo()
            ActivityManager.getMyMemoryState(state)
            return state.importance > ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        }

        /** "写好了" when a passage finished while the player was away (ANDROID_COMPAT F2). */
        private fun notifyReady(context: Context) {
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
                val open = PendingIntent.getActivity(
                    context, 1,
                    Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, DONE_CHANNEL_ID) else Notification.Builder(context)
                manager.notify(
                    DONE_NOTIFICATION_ID,
                    builder.setSmallIcon(R.drawable.ic_stat_seal)
                        .setContentTitle("历史穿越")
                        .setContentText("下一段有结果了，回来看看")
                        .setContentIntent(open)
                        .setAutoCancel(true)
                        .setCategory(Notification.CATEGORY_STATUS)
                        .build()
                )
            } catch (error: Exception) {
                warn("ready notification", error)
            }
        }

        /** Clears the "写好了" notification once the player is back. */
        @JvmStatic
        fun clearReady(context: Context) {
            try {
                context.getSystemService(NotificationManager::class.java)?.cancel(DONE_NOTIFICATION_ID)
            } catch (error: Exception) {
                warn("ready notification removal", error)
            }
        }

        private fun warn(operation: String, error: Exception) {
            // Log the failure class only; never include platform exception text.
            Log.w(TAG, "Generation foreground service $operation failed: ${error.javaClass.simpleName}")
        }

        @JvmStatic
        fun start(context: Context) {
            synchronized(lock) {
                pendingStop?.let { main.removeCallbacks(it) }
                pendingStop = null
                // Already up (a second request of the same turn): nothing to start.
                if (requested && current != null) return
                requested = true
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
