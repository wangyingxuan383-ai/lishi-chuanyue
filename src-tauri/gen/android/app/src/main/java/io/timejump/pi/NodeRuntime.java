package io.timejump.pi;

/** JNI names match the verified, separately built Node embedder. */
public final class NodeRuntime {
    static { System.loadLibrary("lishi_node_embed"); }
    private NodeRuntime() {}
    public static native int[] createBridge();
    public static native int run(String entryPath, String workingDirectory, int protocolFd);
    public static native void abortRuntime();
}
