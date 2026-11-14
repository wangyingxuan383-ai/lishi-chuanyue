package io.timejump.chuanyue

import android.content.Intent

/** The story a tapped notification asked to open (R29-T006); the page takes it once. */
object LaunchTarget {
    private var worldId: String? = null
    private var action: String? = null

    @Synchronized
    fun capture(intent: Intent?) {
        if (intent == null) return
        val world = intent.getStringExtra(GenerationService.EXTRA_WORLD)?.takeIf { it.isNotBlank() && it.length <= 128 } ?: return
        worldId = world
        action = intent.getStringExtra(GenerationService.EXTRA_ACTION)?.takeIf { it == "read" || it == "resume" } ?: "read"
        intent.removeExtra(GenerationService.EXTRA_WORLD)
    }

    @Synchronized
    fun take(): Pair<String, String>? {
        val world = worldId ?: return null
        val result = world to (action ?: "read")
        worldId = null
        action = null
        return result
    }
}
