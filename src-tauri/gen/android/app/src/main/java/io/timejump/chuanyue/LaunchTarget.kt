package io.timejump.chuanyue

import android.content.Intent

/** The story a tapped notification asked to open (R29-T006); the page takes it once. */
object LaunchTarget {
    data class Target(val worldId: String, val action: String, val runId: String?)
    private var pending: Target? = null

    @Synchronized
    fun capture(intent: Intent?): Boolean {
        if (intent == null) return false
        val world = intent.getStringExtra(GenerationService.EXTRA_WORLD)?.takeIf { it.isNotBlank() && it.length <= 128 } ?: return false
        val action = intent.getStringExtra(GenerationService.EXTRA_ACTION)?.takeIf { it == "read" || it == "resume" } ?: "read"
        val run = intent.getStringExtra(GenerationService.EXTRA_RUN)?.takeIf { it.isNotBlank() && it.length <= 160 }
        pending = Target(world, action, run)
        intent.removeExtra(GenerationService.EXTRA_WORLD)
        return true
    }

    @Synchronized
    fun take(): Target? {
        val result = pending
        pending = null
        return result
    }
}
