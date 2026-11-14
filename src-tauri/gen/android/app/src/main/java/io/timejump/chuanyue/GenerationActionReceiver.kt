package io.timejump.chuanyue

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** The 停止 button on the progress notification (R29-T006); not exported. */
class GenerationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_STOP) GenerationService.stopFromNotification()
    }

    companion object {
        const val ACTION_STOP = "io.timejump.chuanyue.STOP_GENERATION"
    }
}
