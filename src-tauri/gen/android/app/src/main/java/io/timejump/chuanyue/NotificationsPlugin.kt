package io.timejump.chuanyue

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.HapticFeedbackConstants
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class UrlArgs {
    var url: String? = null
}

@InvokeArg
class SystemBarsArgs {
    var background: String? = null
    var dark: Boolean = false
}

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class NotificationsPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun request_notification_permission(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            invoke.resolve(JSObject().put("granted", enabled()))
        } else {
            requestPermissionForAlias("notifications", invoke, "notificationResult")
        }
    }

    @PermissionCallback
    fun notificationResult(invoke: Invoke) {
        invoke.resolve(JSObject().put("granted", enabled()))
    }

    /** Whether notifications can show at all: the runtime permission and the app-level switch. */
    @Command
    fun notification_status(invoke: Invoke) {
        val granted = Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED
        invoke.resolve(JSObject().put("granted", granted).put("enabled", enabled()))
    }

    /**
     * Opens this app's notification settings, where a player who said no once
     * can turn them on again (Android does not ask a second time on its own).
     */
    @Command
    fun open_notification_settings(invoke: Invoke) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
        }
        try {
            activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (error: Exception) {
            // Some ROMs lack the notification screen: fall back to the app's details page.
            activity.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
        invoke.resolve()
    }

    /** Opens the app's details page, where battery and autostart limits live on most ROMs. */
    @Command
    fun open_app_settings(invoke: Invoke) {
        activity.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        invoke.resolve()
    }

    /** Opens an https page in the browser (key consoles, price lists, the release page). */
    @Command
    fun open_url(invoke: Invoke) {
        val args = invoke.parseArgs(UrlArgs::class.java)
        val url = args.url ?: ""
        if (!url.startsWith("https://")) { invoke.reject("only https links"); return }
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject("no browser")
        }
    }

    /** Status and navigation bars in the app theme's background; `dark` = light icons. */
    @Command
    fun set_system_bars(invoke: Invoke) {
        val args = invoke.parseArgs(SystemBarsArgs::class.java)
        val color = try {
            Color.parseColor(args.background ?: "")
        } catch (error: IllegalArgumentException) {
            invoke.reject("bad colour"); return
        }
        activity.runOnUiThread {
            SystemBars.apply(activity, color, args.dark)
            SystemBars.remember(activity, color, args.dark)
            invoke.resolve()
        }
    }

    /**
     * A light tap for a long press. performHapticFeedback needs no VIBRATE
     * permission and respects the system's touch-feedback switch.
     */
    @Command
    fun haptic(invoke: Invoke) {
        activity.runOnUiThread {
            val done = activity.window.decorView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            invoke.resolve(JSObject().put("done", done))
        }
    }

    private fun enabled(): Boolean = activity.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() ?: true
}
