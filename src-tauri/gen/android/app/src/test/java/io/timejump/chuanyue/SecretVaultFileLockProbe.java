package io.timejump.chuanyue;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Standalone JDK check: temporary fake data only, no Android or credentials. */
public final class SecretVaultFileLockProbe {
    private static final long WAIT_MS = 5000;

    public static void main(String[] args) throws Exception {
        if (args.length == 3 && args[0].equals("child")) {
            child(new File(args[1]), args[2]);
            return;
        }
        if (args.length != 1) throw new IllegalArgumentException("Provide one new fixture directory");
        File root = new File(args[0]).getCanonicalFile();
        if (!root.isAbsolute() || root.exists() || !root.mkdirs()) {
            throw new IOException("Fixture directory must be new");
        }
        File lock = new File(root, "namespace.lock");
        write(new File(root, "counter"), "0");
        Process[] waiting = new Process[1];
        SecretVaultFileLock.withLock(lock, () -> {
            waiting[0] = start(root, "increment");
            awaitFile(new File(root, "increment-attempt"));
            try {
                require(!waiting[0].waitFor(200, TimeUnit.MILLISECONDS), "Other process bypassed lock");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IOException(error);
            }
            require(!new File(root, "increment-entered").exists(), "Reader entered an in-flight write");
            return null;
        });
        require(waiting[0].waitFor(WAIT_MS, TimeUnit.MILLISECONDS) && waiting[0].exitValue() == 0,
                "Waiting process did not continue after release");
        require(readCounter(root) == 1, "Process update missing");

        CountDownLatch go = new CountDownLatch(1);
        AtomicReference<Throwable> failed = new AtomicReference<>();
        List<Thread> threads = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            Thread thread = new Thread(() -> {
                try {
                    go.await();
                    for (int j = 0; j < 30; j++) {
                        SecretVaultFileLock.withLock(lock, () -> { increment(root); return null; });
                    }
                } catch (Throwable error) { failed.compareAndSet(null, error); }
            });
            threads.add(thread);
            thread.start();
        }
        go.countDown();
        for (Thread thread : threads) thread.join(WAIT_MS);
        require(threads.stream().noneMatch(Thread::isAlive), "Same-process lock timed out");
        if (failed.get() != null) throw new AssertionError("Overlapping JVM lock or lost update", failed.get());
        require(readCounter(root) == 121, "Thread update missing");

        Process held = start(root, "hold");
        try {
            awaitFile(new File(root, "hold-entered"));
        } finally {
            held.destroyForcibly();
            require(held.waitFor(WAIT_MS, TimeUnit.MILLISECONDS), "Owned child did not stop");
        }
        SecretVaultFileLock.withLock(lock, () -> { increment(root); return null; });
        require(readCounter(root) == 122, "Process exit did not release lock");
        try {
            SecretVaultFileLock.withLock(lock, () -> { throw new IOException("fixed fixture failure"); });
            throw new AssertionError("Action error disappeared");
        } catch (IOException expected) {
            require(expected.getMessage().equals("fixed fixture failure"), "Unexpected fixture failure");
        }
        SecretVaultFileLock.withLock(lock, () -> { increment(root); return null; });
        require(readCounter(root) == 123 && lock.isFile(), "Error did not release stable lock file");
        System.out.println("{\"passed\":4,\"crossProcess\":true,\"sameProcess\":true,\"processExit\":true,\"actionError\":true,\"credentialsRead\":false}");
    }

    private static void child(File root, String mode) throws Exception {
        write(new File(root, mode + "-attempt"), "attempt");
        SecretVaultFileLock.withLock(new File(root, "namespace.lock"), () -> {
            write(new File(root, mode + "-entered"), "entered");
            if (mode.equals("hold")) {
                try { new CountDownLatch(1).await(); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
            } else { increment(root); }
            return null;
        });
    }

    private static Process start(File root, String mode) throws IOException {
        String java = new File(System.getProperty("java.home"), "bin/" +
                (System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java")).getPath();
        return new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"),
                SecretVaultFileLockProbe.class.getName(), "child", root.getPath(), mode)
                .redirectOutput(new File(root, mode + "-stdout"))
                .redirectError(new File(root, mode + "-stderr")).start();
    }

    private static void awaitFile(File file) throws IOException {
        long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(WAIT_MS);
        while (!file.isFile() && System.nanoTime() < until) {
            try { Thread.sleep(10); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
        }
        require(file.isFile(), "Child handshake timed out");
    }
    private static void increment(File root) throws IOException { write(new File(root, "counter"), Integer.toString(readCounter(root) + 1)); }
    private static int readCounter(File root) throws IOException { return Integer.parseInt(new String(Files.readAllBytes(new File(root, "counter").toPath()), StandardCharsets.UTF_8)); }
    private static void write(File file, String value) throws IOException { Files.write(file.toPath(), value.getBytes(StandardCharsets.UTF_8)); }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
