package io.timejump.lishi

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.tauri.annotation.ActivityCallback
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Protocol/lifecycle guards only; the actual SAF selection still needs device UI acceptance. */
@RunWith(AndroidJUnit4::class)
class DocumentPickerTest {
    @Test
    fun importUsesOpenDocumentReadOnlyAndNoPersistentOrArbitraryInitialUri() {
        val intent = buildImportDocumentIntent()
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.action)
        assertTrue(intent.categories.contains(Intent.CATEGORY_OPENABLE))
        assertEquals("application/octet-stream", intent.type)
        assertFalse(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, true))
        assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, intent.flags)
        assertEquals(0, intent.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        assertEquals(0, intent.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        assertNull(intent.data)
        assertNull(intent.`package`)
    }

    @Test
    fun cancelNullAndNonContentRepliesContainNoUri() {
        val cancelled = decodeDocumentPickerResult(ActivityResult(Activity.RESULT_CANCELED, null))
        assertEquals("cancelled", cancelled.getString("status"))
        assertFalse(cancelled.has("uri"))
        for (intent in listOf(null, Intent(), Intent().setData(Uri.parse("file:///private/key")))) {
            val reply = decodeDocumentPickerResult(ActivityResult(Activity.RESULT_OK, intent))
            assertEquals("file_unavailable", reply.getString("code"))
            assertFalse(reply.has("uri"))
        }
    }

    @Test
    fun onlyOneBoundedContentUriCanBeSelected() {
        val uri = Uri.parse("content://example.documents/document/42")
        val reply = decodeDocumentPickerResult(ActivityResult(Activity.RESULT_OK, Intent().setData(uri)))
        assertEquals("selected", reply.getString("status"))
        assertEquals(uri.toString(), reply.getString("uri"))
        val many = Intent().setData(uri)
        many.clipData = ClipData.newRawUri("documents", uri).apply { addItem(ClipData.Item(uri)) }
        assertEquals("file_unavailable", decodeDocumentPickerResult(ActivityResult(Activity.RESULT_OK, many)).getString("code"))
        val large = Intent().setData(Uri.parse("content://example.documents/" + "a".repeat(8192)))
        assertEquals("file_unavailable", decodeDocumentPickerResult(ActivityResult(Activity.RESULT_OK, large)).getString("code"))
    }

    @Test
    fun timeoutResolvesOnceAndLateOrRepeatedResultCannotOverwriteIt() {
        val replies = mutableListOf<JSObject>()
        val gate = DocumentPickerReplyGate { replies.add(it) }
        assertTrue(gate.timedOut())
        assertFalse(gate.finish(JSObject().put("status", "selected").put("uri", "content://example/file")))
        assertFalse(gate.timedOut())
        assertEquals(1, replies.size)
        assertEquals("file_unconfirmed", replies.single().getString("code"))
        assertFalse(replies.single().has("uri"))
    }

    @Test
    fun initialResumeDoesNotResolveAndPausedReturnOnlyResolvesCurrentGate() {
        val oldReplies = mutableListOf<JSObject>()
        val newReplies = mutableListOf<JSObject>()
        val old = DocumentPickerReplyGate { oldReplies.add(it) }
        val fresh = DocumentPickerReplyGate { newReplies.add(it) }
        assertFalse(old.returnedWithoutCallback())
        assertTrue(oldReplies.isEmpty())
        old.paused()
        assertTrue(old.returnedWithoutCallback())
        assertFalse(old.finish(JSObject().put("status", "cancelled")))
        assertTrue(newReplies.isEmpty())
        assertFalse(fresh.hasPaused)
        assertTrue(fresh.finish(JSObject().put("status", "cancelled")))
        assertEquals(1, oldReplies.size)
        assertEquals(1, newReplies.size)
    }

    @Test
    fun timedOutRequestBlocksNewPickUntilReturnAndOldReleaseCannotClearNewRequest() {
        val slot = DocumentPickerRequestSlot<DocumentPickerReplyGate>()
        val old = DocumentPickerReplyGate { }
        val fresh = DocumentPickerReplyGate { }
        assertTrue(slot.acquire(old))
        old.timedOut()
        assertFalse(slot.acquire(fresh))
        assertTrue(slot.release(old))
        assertTrue(slot.acquire(fresh))
        assertFalse(slot.release(old))
        assertTrue(slot.current === fresh)
        assertTrue(slot.release(fresh))
        assertNull(slot.current)
    }

    @Test
    fun activityResultCallbackIsRegisteredWithExactTauriSignature() {
        val method = DocumentPickerPlugin::class.java.getDeclaredMethod(
            "documentResult", Invoke::class.java, ActivityResult::class.java
        )
        assertTrue(method.annotations.any { it.annotationClass.java == ActivityCallback::class.java })
    }
}
