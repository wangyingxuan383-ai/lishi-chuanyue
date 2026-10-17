package io.timejump.chuanyue

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class PackageArgs {
    var path: String? = null
}

/**
 * Hands a downloaded update to the system package installer (R14 应用内更新).
 * Only Rust calls these commands: no capability names them, so the page
 * cannot, and Rust has checked the package's SHA-256 again just before.
 */
@TauriPlugin
class UpdatePlugin(private val activity: Activity) : Plugin(activity) {
    /** Android 8+ asks once per app (“安装未知应用”); older versions ask inside the installer. */
    @Command
    fun canInstallPackages(invoke: Invoke) {
        invoke.resolve(JSObject().put("allowed", allowed()))
    }

    /**
     * Opens the system installer for `<cacheDir>/updates/<version>.apk` through
     * the app's FileProvider. Without the install permission it opens this app's
     * “安装未知应用” switch instead; the player comes back and taps 安装 again.
     */
    @Command
    fun installPackage(invoke: Invoke) {
        val path = invoke.parseArgs(PackageArgs::class.java).path ?: ""
        val folder = File(activity.cacheDir, "updates").canonicalFile
        val file = try { File(path).canonicalFile } catch (error: Exception) { null }
        if (file == null || file.parentFile != folder || !file.name.endsWith(".apk") || !file.isFile) {
            invoke.reject("update package unavailable")
            return
        }
        if (!allowed()) {
            openInstallSettings()
            invoke.resolve(JSObject().put("status", "permission"))
            return
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(intent)
            invoke.resolve(JSObject().put("status", "started"))
        } catch (error: ActivityNotFoundException) {
            invoke.reject("no package installer")
        }
    }

    private fun allowed(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return activity.packageManager.canRequestPackageInstalls()
    }

    /** This app's “安装未知应用” switch; ROMs without that screen get the app's details page. */
    private fun openInstallSettings() {
        val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            activity.startActivity(details)
            return
        }
        try {
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (error: ActivityNotFoundException) {
            activity.startActivity(details)
        }
    }
}
