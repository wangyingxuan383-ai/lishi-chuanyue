package io.timejump.chuanyue

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** The 停止 button on the progress notification and :agent background commit bridge; not exported. */
class GenerationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_STOP -> GenerationService.stopFromNotification(
                intent.getStringExtra(EXTRA_RUN_ID) ?: "",
                intent.getStringExtra(EXTRA_EXECUTION_ID) ?: ""
            )
            ACTION_STORY_COMMITTED -> {
                val completionId = intent.getStringExtra(EXTRA_COMPLETION_ID)?.trim().orEmpty()
                if (completionId.isNotEmpty() && completionId.length <= 256) {
                    GenerationService.storyCommitted(
                        context,
                        completionId,
                        (intent.getStringExtra(EXTRA_WORLD_ID) ?: "").take(128),
                        (intent.getStringExtra(EXTRA_TITLE) ?: "").take(60),
                        (intent.getStringExtra(EXTRA_EXCERPT) ?: "").take(120)
                    )
                }
            }
        }
    }

    companion object {
        const val ACTION_STOP = "io.timejump.chuanyue.STOP_GENERATION"
        const val ACTION_STORY_COMMITTED = "io.timejump.chuanyue.AGENT_STORY_COMMITTED"
        const val EXTRA_RUN_ID = "generationRunId"
        const val EXTRA_EXECUTION_ID = "generationExecutionId"
        const val EXTRA_COMPLETION_ID = "completionId"
        const val EXTRA_WORLD_ID = "worldId"
        const val EXTRA_TITLE = "storyTitle"
        const val EXTRA_EXCERPT = "storyExcerpt"
    }
}
