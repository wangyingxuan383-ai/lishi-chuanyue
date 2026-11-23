package io.timejump.chuanyue

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.WindowManager
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

@InvokeArg
class CompletionArgs {
    var completionId: String = ""
    var worldId: String = ""
    var title: String = ""
    var excerpt: String = ""
}

@InvokeArg
class FailedArgs {
    var worldId: String = ""
    var title: String = ""
    var status: String = "failed"
    var line: String = ""
    var runId: String = ""
}

@InvokeArg
class NotifyPrefsArgs {
    var progress: Boolean = true
    var excerpt: Boolean = true
    var lockscreen: Boolean = false
    var sound: Boolean = true
}

@InvokeArg
class AwakeArgs { var enabled: Boolean = false }

@InvokeArg
class SettingsTargetArgs { var target: String = "app" }

internal object RomCompat {
    private fun prop(key: String): String = try {
        val cls = Class.forName("android.os.SystemProperties")
        val get = cls.getMethod("get", String::class.java, String::class.java)
        (get.invoke(null, key, "") as? String)?.trim().orEmpty()
    } catch (_: Throwable) {
        ""
    }

    /** Detects the 7 OEM ROM families: xiaomi | vivo | oppo | honor | huawei | samsung | generic. */
    fun detectOem(): String {
        val brand = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        if (
            prop("ro.mi.os.version.name").isNotEmpty() ||
            prop("ro.miui.ui.version.name").isNotEmpty() ||
            listOf("xiaomi", "redmi", "poco", "blackshark").any { brand.contains(it) }
        ) return "xiaomi"

        if (
            prop("ro.vivo.os.version").isNotEmpty() ||
            prop("ro.vivo.os.build.display.id").isNotEmpty() ||
            listOf("vivo", "iqoo").any { brand.contains(it) }
        ) return "vivo"

        if (
            prop("ro.build.version.opporom").isNotEmpty() ||
            prop("ro.build.version.oplusrom").isNotEmpty() ||
            listOf("oppo", "oneplus", "realme", "oplus").any { brand.contains(it) }
        ) return "oppo"

        if (
            prop("ro.magic.api.version").isNotEmpty() ||
            prop("msc.config.magic.version").isNotEmpty() ||
            prop("ro.build.version.magic").isNotEmpty() ||
            brand.contains("honor")
        ) return "honor"

        if (
            prop("ro.build.version.emui").isNotEmpty() ||
            prop("hw_sc.build.platform.version").isNotEmpty() ||
            listOf("huawei", "harmony").any { brand.contains(it) }
        ) return "huawei"

        if (
            prop("ro.build.version.oneui").isNotEmpty() ||
            prop("ro.build.version.sep").isNotEmpty() ||
            brand.contains("samsung")
        ) return "samsung"

        return "generic"
    }

    fun autostartComponents(oem: String): List<ComponentName> {
        val byBrand = linkedMapOf(
            "xiaomi" to listOf(
                ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
                ComponentName("com.miui.securitycenter", "com.miui.powercenter.PowerSettings")
            ),
            "vivo" to listOf(
                ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
                ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity")
            ),
            "oppo" to listOf(
                ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                ComponentName("com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity"),
                ComponentName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
                ComponentName("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity")
            ),
            "honor" to listOf(
                ComponentName("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupAppControlActivity"),
                ComponentName("com.hihonor.systemmanager", "com.hihonor.systemmanager.optimize.process.ProtectActivity")
            ),
            "huawei" to listOf(
                ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
                ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity")
            ),
            "samsung" to listOf(
                ComponentName("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.usage.SleepingAppsActivity"),
                ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
                ComponentName("com.samsung.android.sm_cn", "com.samsung.android.sm.ui.ram.AutoRunActivity")
            )
        )
        val ordered = ArrayList<ComponentName>()
        byBrand[oem]?.let { ordered.addAll(it) }
        for ((brand, list) in byBrand) {
            if (brand != oem) ordered.addAll(list)
        }
        return ordered
    }
}

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class NotificationsPlugin(private val activity: Activity) : Plugin(activity) {
    private fun appDetailsIntent(): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))

    /** Wraps every startActivity in try/catch + FLAG_ACTIVITY_NEW_TASK so no OEM ROM can crash. */
    private fun startSafely(intents: List<Intent>): Boolean {
        for (candidate in intents) {
            try {
                activity.startActivity(Intent(candidate).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            } catch (_: Throwable) {
                // Try the next fallback screen on custom ROMs.
            }
        }
        return false
    }

    private fun startSafely(vararg intents: Intent): Boolean = startSafely(intents.toList())

    private fun openTarget(target: String) {
        when (target) {
            "notifications" -> {
                val list = ArrayList<Intent>()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    list.add(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName))
                }
                list.add(
                    Intent("android.settings.APP_NOTIFICATION_SETTINGS")
                        .putExtra("app_package", activity.packageName)
                        .putExtra("app_uid", activity.applicationInfo.uid)
                )
                list.add(appDetailsIntent())
                list.add(Intent(Settings.ACTION_SETTINGS))
                startSafely(list)
            }
            "channel_done", "channel_failed" -> {
                val issue = target == "channel_failed"
                // Ensure story_done / story_failed exists before opening its channel settings.
                val channelId = GenerationService.ensureChannel(activity, issue = issue, sound = true)
                val list = ArrayList<Intent>()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    list.add(
                        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
                            .putExtra(Settings.EXTRA_CHANNEL_ID, channelId)
                    )
                    list.add(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName))
                }
                list.add(appDetailsIntent())
                list.add(Intent(Settings.ACTION_SETTINGS))
                startSafely(list)
            }
            "battery" -> {
                startSafely(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${activity.packageName}")),
                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                    appDetailsIntent(),
                    Intent(Settings.ACTION_SETTINGS)
                )
            }
            "autostart" -> {
                val oem = RomCompat.detectOem()
                val intents = RomCompat.autostartComponents(oem)
                    .map { component -> Intent().setComponent(component) } +
                    listOf(appDetailsIntent(), Intent(Settings.ACTION_SETTINGS))
                startSafely(intents)
            }
            else -> {
                startSafely(appDetailsIntent(), Intent(Settings.ACTION_SETTINGS))
            }
        }
    }

    @Command
    fun story_committed(invoke: Invoke) {
        val args = invoke.parseArgs(CompletionArgs::class.java)
        val id = args.completionId
        if (id.isBlank() || id.length > 256) { invoke.reject("invalid completion id"); return }
        GenerationService.storyCommitted(activity, id, args.worldId.take(128), args.title.take(60), args.excerpt.take(120))
        invoke.resolve()
    }

    @Command
    fun story_failed(invoke: Invoke) {
        val args = invoke.parseArgs(FailedArgs::class.java)
        GenerationService.storyIssue(
            activity,
            args.worldId.take(128),
            args.title.take(60),
            args.status.take(32),
            args.line.take(120),
            args.runId.take(160)
        )
        invoke.resolve()
    }

    @Command
    fun background_status(invoke: Invoke) {
        val power = activity.getSystemService(PowerManager::class.java)
        val ignoring = power?.isIgnoringBatteryOptimizations(activity.packageName) ?: false
        val oem = RomCompat.detectOem()
        invoke.resolve(
            JSObject()
                .put("ignoringBattery", ignoring)
                .put("xiaomi", oem == "xiaomi")
                .put("oem", oem)
        )
    }

    @Command
    fun request_battery_exemption(invoke: Invoke) {
        openTarget("battery")
        invoke.resolve()
    }

    @Command
    fun open_autostart_settings(invoke: Invoke) {
        openTarget("autostart")
        invoke.resolve()
    }

    @Command
    fun open_system_settings(invoke: Invoke) {
        val target = try { invoke.parseArgs(SettingsTargetArgs::class.java).target } catch (_: Exception) { "app" }
        openTarget(target)
        invoke.resolve()
    }

    @Command
    fun set_notify_prefs(invoke: Invoke) {
        val args = invoke.parseArgs(NotifyPrefsArgs::class.java)
        GenerationService.prefs(activity).edit()
            .putBoolean(GenerationService.PREF_PROGRESS, args.progress)
            .putBoolean(GenerationService.PREF_EXCERPT, args.excerpt)
            .putBoolean(GenerationService.PREF_LOCKSCREEN, args.lockscreen)
            .putBoolean(GenerationService.PREF_SOUND, args.sound)
            .apply()
        invoke.resolve()
    }

    @Command
    fun reminder_status(invoke: Invoke) {
        val (sound, audible) = GenerationService.reminderAudible(activity)
        invoke.resolve(JSObject().put("sound", sound).put("audible", audible))
    }

    @Command
    fun test_reminder(invoke: Invoke) {
        GenerationService.testReminder(activity)
        invoke.resolve()
    }

    @Command
    fun open_reminder_settings(invoke: Invoke) {
        val channelId = GenerationService.mutedReminderChannel(activity)
        val list = ArrayList<Intent>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            list.add(
                Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
                    .putExtra(Settings.EXTRA_CHANNEL_ID, channelId)
            )
            list.add(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName))
        }
        list.add(appDetailsIntent())
        list.add(Intent(Settings.ACTION_SETTINGS))
        startSafely(list)
        invoke.resolve()
    }

    @Command
    fun take_launch_target(invoke: Invoke) {
        val target = LaunchTarget.take()
        invoke.resolve(JSObject().put("worldId", target?.worldId).put("action", target?.action).put("runId", target?.runId))
    }

    @Command
    fun set_keep_awake(invoke: Invoke) {
        val enabled = invoke.parseArgs(AwakeArgs::class.java).enabled
        activity.runOnUiThread {
            if (enabled) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            invoke.resolve()
        }
    }

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

    /** Returns granted, enabled, oem, channelImportance, canFloat, and reminderAudible. */
    @Command
    fun notification_status(invoke: Invoke) {
        val granted = Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED
        val appEnabled = enabled()
        val oem = RomCompat.detectOem()
        val (importance, rawFloat) = GenerationService.channelStatus(activity)
        val (_, audible) = GenerationService.reminderAudible(activity)
        invoke.resolve(
            JSObject()
                .put("granted", granted)
                .put("enabled", granted && appEnabled)
                .put("oem", oem)
                .put("channelImportance", importance)
                .put("canFloat", granted && appEnabled && rawFloat)
                .put("reminderAudible", granted && appEnabled && audible)
        )
    }

    @Command
    fun open_notification_settings(invoke: Invoke) {
        openTarget("notifications")
        invoke.resolve()
    }

    @Command
    fun open_app_settings(invoke: Invoke) {
        openTarget("app")
        invoke.resolve()
    }

    @Command
    fun open_url(invoke: Invoke) {
        val args = invoke.parseArgs(UrlArgs::class.java)
        val url = args.url ?: ""
        if (!url.startsWith("https://")) { invoke.reject("only https links"); return }
        if (startSafely(Intent(Intent.ACTION_VIEW, Uri.parse(url)))) {
            invoke.resolve()
        } else {
            invoke.reject("no browser")
        }
    }

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

    @Command
    fun haptic(invoke: Invoke) {
        activity.runOnUiThread {
            val done = activity.window.decorView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            invoke.resolve(JSObject().put("done", done))
        }
    }

    private fun enabled(): Boolean = activity.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() ?: true
}
