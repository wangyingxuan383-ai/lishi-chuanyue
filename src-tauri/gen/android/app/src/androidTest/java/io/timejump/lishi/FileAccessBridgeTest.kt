package io.timejump.lishi

import android.content.Context
import android.os.ParcelFileDescriptor
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.lang.reflect.Modifier
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Real target ContentResolver tests. Does not substitute for a SAF picker/JNI device test. */
@RunWith(AndroidJUnit4::class)
class FileAccessBridgeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var directory: File

    @Before
    fun prepare() {
        directory = File(context.cacheDir, "m01-file-test-${UUID.randomUUID()}")
        assertTrue(directory.mkdir())
    }

    @After
    fun cleanup() {
        // Only flat files created inside this test's unique private directory.
        directory.listFiles()?.forEach { if (it.isFile) it.delete() }
        directory.delete()
    }

    private fun uriFor(file: File): String = FileProvider.getUriForFile(
        context, "${context.packageName}.fileprovider", file
    ).toString()

    @Test
    fun contentUriReadsWholeChineseDocumentAndOwnedDescriptorCloses() {
        val file = File(directory, "中文存档🙂.lishi-probe")
        val expected = "长安的钥匙🔑\n第二行\r\n🙂\u0000".toByteArray(Charsets.UTF_8)
        file.writeBytes(expected)
        val uri = uriFor(file)
        assertTrue(uri.startsWith("content://"))
        val descriptor = RustFileAccessBridge.openFdForRust(context, uri, "r")
        assertTrue(descriptor >= 0)
        val actual = ParcelFileDescriptor.AutoCloseInputStream(
            ParcelFileDescriptor.adoptFd(descriptor)
        ).use { it.readBytes() }
        assertArrayEquals(expected, actual)
        assertTrue(file.delete())
    }

    @Test
    fun writeTruncatesOldDocumentAndPreservesChineseBytes() {
        val file = File(directory, "导出探针.lishi-probe")
        file.writeText("old content much longer than replacement".repeat(10))
        val replacement = "导出🙂\n确认整段内容".toByteArray(Charsets.UTF_8)
        val descriptor = RustFileAccessBridge.openFdForRust(context, uriFor(file), "wt")
        assertTrue(descriptor >= 0)
        ParcelFileDescriptor.AutoCloseOutputStream(
            ParcelFileDescriptor.adoptFd(descriptor)
        ).use { it.write(replacement) }
        assertArrayEquals(replacement, file.readBytes())
    }

    @Test
    fun missingDocumentOrInvalidUriAndModeFailWithoutChangingOriginal() {
        val file = File(directory, "保留原文.lishi-probe")
        file.writeText("原文")
        val uri = uriFor(file)
        assertEquals(-1, RustFileAccessBridge.openFdForRust(context, uri, "rw"))
        assertEquals(-1, RustFileAccessBridge.openFdForRust(context, file.toURI().toString(), "r"))
        assertEquals(-1, RustFileAccessBridge.openFdForRust(context, "content://" + "a".repeat(8192), "r"))
        assertEquals("原文", file.readText())
        assertTrue(file.delete())
        assertEquals(-1, RustFileAccessBridge.openFdForRust(context, uri, "r"))
    }

    @Test
    fun bridgeIsStaticAndHasNoWebviewOrPluginCommandAnnotation() {
        val method = RustFileAccessBridge::class.java.getDeclaredMethod(
            "openFdForRust", Context::class.java, String::class.java, String::class.java
        )
        assertTrue(Modifier.isStatic(method.modifiers))
        assertEquals(Int::class.javaPrimitiveType, method.returnType)
        assertFalse(method.annotations.any {
            it.annotationClass.java.name in setOf(
                "app.tauri.annotation.Command", "android.webkit.JavascriptInterface"
            )
        })
    }
}
