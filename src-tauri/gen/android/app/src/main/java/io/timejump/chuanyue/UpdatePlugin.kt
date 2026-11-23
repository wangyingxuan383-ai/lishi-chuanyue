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
        try {
            invoke.resolve(JSObject().put("allowed", allowed()))
        } catch (error: Exception) {
            invoke.reject("无法读取安装未知应用权限")
        }
    }

    /**
     * Opens the system installer for `<cacheDir>/updates/<version>.apk` through
     * the app's FileProvider. Without the install permission it opens this app's
     * “安装未知应用” switch instead; the player comes back and taps 安装 again.
     */
    @Command
    fun installPackage(invoke: Invoke) {
        val path = try {
            invoke.parseArgs(PackageArgs::class.java).path ?: ""
        } catch (error: Exception) {
            invoke.reject("无法读取更新安装包路径")
            return
        }
        val folder = try {
            File(activity.cacheDir, "updates").canonicalFile
        } catch (error: Exception) {
            invoke.reject("无法访问更新缓存目录")
            return
        }
        val file = try { File(path).canonicalFile } catch (error: Exception) { null }
        if (file == null || file.parentFile != folder || !file.name.endsWith(".apk") || !file.isFile) {
            invoke.reject("更新安装包不可用，请重新下载")
            return
        }
        val canInstall = try {
            allowed()
        } catch (error: Exception) {
            invoke.reject("无法检查安装未知应用权限")
            return
        }
        if (!canInstall) {
            if (!openInstallSettings()) {
                invoke.reject("无法打开“安装未知应用”系统设置，请在系统设置中手动开启")
                return
            }
            invoke.resolve(JSObject().put("status", "permission"))
            return
        }
        val uri = try {
            FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        } catch (error: Exception) {
            invoke.reject("无法准备更新安装包文件授权，请重新下载后重试")
            return
        }
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(intent)
            invoke.resolve(JSObject().put("status", "started"))
        } catch (error: ActivityNotFoundException) {
            invoke.reject("未找到系统软件包安装程序，无法安装更新")
        } catch (error: SecurityException) {
            invoke.reject("系统拒绝打开安装程序，请检查安装未知应用权限")
        } catch (error: Exception) {
            invoke.reject("没能打开系统安装界面，请稍后重试")
        }
    }

    private fun allowed(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return activity.packageManager.canRequestPackageInstalls()
    }

    /** This app's “安装未知应用” switch; ROMs without that screen get the app's details page. */
    private fun openInstallSettings(): Boolean {
        val pkgUri = Uri.parse("package:${activity.packageName}")
        val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, pkgUri)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
                return true
            } catch (_: Exception) {
                // Fall back to app details settings on custom ROMs that omit or block the unknown-sources screen.
            }
        }
        return try {
            activity.startActivity(details)
            true
        } catch (_: Exception) {
            try {
                activity.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                true
            } catch (_: Exception) {
                false
            }
        }
    }
}
