package io.timejump.chuanyue

import android.Manifest
import android.app.Activity
import android.os.Build
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class NotificationsPlugin(activity: Activity) : Plugin(activity) {
    @Command
    fun request_notification_permission(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            invoke.resolve(JSObject().put("granted", true))
        } else {
            requestPermissionForAlias("notifications", invoke, "notificationResult")
        }
    }

    @PermissionCallback
    fun notificationResult(invoke: Invoke) {
        invoke.resolve(JSObject().put("granted", getPermissionState("notifications") == PermissionState.GRANTED))
    }
}
