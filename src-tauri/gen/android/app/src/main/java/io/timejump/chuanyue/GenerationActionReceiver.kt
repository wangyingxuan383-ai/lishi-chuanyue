package io.timejump.chuanyue

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** The 停止 button on the progress notification (R29-T006); not exported. */
class GenerationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_STOP) GenerationService.stopFromNotification(
            intent.getStringExtra(EXTRA_RUN_ID) ?: "", intent.getStringExtra(EXTRA_EXECUTION_ID) ?: ""
        )
    }

    companion object {
        const val ACTION_STOP = "io.timejump.chuanyue.STOP_GENERATION"
        const val EXTRA_RUN_ID = "generationRunId"
        const val EXTRA_EXECUTION_ID = "generationExecutionId"
    }
}
