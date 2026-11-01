package io.timejump.pi;

/** JNI names deliberately match the independently built Node embedder. */
public final class NodeRuntime {
    static { System.loadLibrary("lishi_node_embed"); }
    private NodeRuntime() {}
    public static native int[] createBridge();
    public static native int run(String entryPath, String workingDirectory, int protocolFd);
    public static native void abortRuntime();
}
