package io.timejump.chuanyue;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;

/** Serializes ciphertext and Keystore operations across the app and :agent. */
final class SecretVaultFileLock {
    // FileChannel.lock() throws instead of waiting for an overlapping JVM
    // lock. Keep this guard even when callers have their own instance lock.
    private static final Object LOCAL = new Object();

    interface Operation<T> { T run() throws IOException; }

    static <T> T withLock(File lockFile, Operation<T> operation) throws IOException {
        synchronized (LOCAL) {
            File parent = lockFile.getParentFile();
            if (parent == null || (!parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory())) {
                throw new IOException("Secret storage lock directory is unavailable");
            }
            // This stable file is separate from the atomic ciphertext files.
            // Never unlink it on release: another process may already have
            // opened the same inode and be waiting for this lock.
            try (RandomAccessFile file = new RandomAccessFile(lockFile, "rw");
                 FileChannel channel = file.getChannel();
                 FileLock ignored = channel.lock()) {
                return operation.run();
            }
        }
    }

    private SecretVaultFileLock() {}
}
