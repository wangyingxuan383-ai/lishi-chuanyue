package io.timejump.pi

/** Isolated JNI contract. Not loaded by the application until the runtime gate passes. */
object NodeRuntime {
    init { System.loadLibrary("lishi_node_embed") }

    /** Two owned UNIX descriptors; caller adopts/owns both before transferring one to run. */
    @JvmStatic external fun createBridge(): IntArray

    /**
     * Runs once on a dedicated thread in :agent. Never call on the Android main thread.
     * protocolFd is transferred to the trusted Node entry's net.Socket; do not close it
     * concurrently. A bootstrap failure is terminal for this service process.
     */
    @JvmStatic external fun run(entryPath: String, workingDirectory: String, protocolFd: Int): Int

    /** Force-stops this runtime; use the Pi protocol abort command for normal task stop. */
    @JvmStatic external fun abortRuntime()
}
