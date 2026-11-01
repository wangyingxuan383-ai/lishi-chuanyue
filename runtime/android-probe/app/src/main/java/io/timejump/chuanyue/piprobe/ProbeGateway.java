package io.timejump.chuanyue.piprobe;

/** Owned fixture only. This library never opens the application's story DB. */
public final class ProbeGateway {
    static { System.loadLibrary("lishi_pi_probe_gateway"); }
    private ProbeGateway() {}
    public static native void initialize(String directory);
    public static native String invoke(String request);
    public static native String snapshot();
}
