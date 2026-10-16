package io.timejump.chuanyue

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.IOException
import java.security.KeyStore
import java.util.UUID
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Instrumented device tests only. Uses isolated fake slots, never user's API keys. */
@RunWith(AndroidJUnit4::class)
class SecretStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var namespace: String
    private lateinit var vault: AndroidSecretVault

    @Before
    fun prepare() {
        namespace = "io.timejump.chuanyue.secret-test.${UUID.randomUUID()}"
        vault = AndroidSecretVault(context, namespace)
    }

    @After
    fun cleanup() {
        for (slot in listOf("alpha", "beta")) {
            try { vault.delete(slot) } catch (_: Exception) { }
        }
        // Remove only this isolated test namespace's now-empty directory.
        vault.directory.delete()
    }

    private fun expectCode(code: String, operation: () -> Unit) {
        var actual: String? = null
        try { operation() } catch (error: SecretVaultException) { actual = error.code }
        assertEquals(code, actual)
    }

    @Test
    fun saveLoadReopenAndUpdateUsesNewNonce() {
        assertNull(vault.load("alpha"))
        val fakeSecret = "fake-local-test-token-001"
        vault.save("alpha", fakeSecret)
        assertTrue(vault.directory.canonicalPath.startsWith(context.noBackupFilesDir.canonicalPath + "/"))
        assertEquals(fakeSecret, AndroidSecretVault(context, namespace).load("alpha"))
        val first = JSONObject(vault.recordFile("alpha").readText())
        assertFalse(vault.recordFile("alpha").readText().contains(fakeSecret))
        assertEquals(setOf("version", "nonce", "ciphertext"), first.keys().asSequence().toSet())
        vault.save("alpha", "fake-local-test-token-002")
        val second = JSONObject(vault.recordFile("alpha").readText())
        assertNotEquals(first.getString("nonce"), second.getString("nonce"))
        assertEquals("fake-local-test-token-002", vault.load("alpha"))
    }

    @Test
    fun deleteRemovesCiphertextAndAliasAndIsRepeatable() {
        vault.save("alpha", "fake-delete-token")
        vault.delete("alpha")
        assertNull(vault.load("alpha"))
        assertFalse(vault.exists("alpha"))
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertFalse(store.containsAlias(vault.alias("alpha")))
        vault.delete("alpha")
    }

    @Test
    fun malformedAndOversizedRecordsAreRejected() {
        vault.save("alpha", "fake-corruption-token")
        vault.recordFile("alpha").writeText("not-json")
        expectCode("corrupted") { vault.load("alpha") }
        vault.recordFile("alpha").writeBytes(ByteArray(MAX_RECORD_BYTES + 1))
        expectCode("corrupted") { vault.load("alpha") }
    }

    @Test
    fun missingAliasDoesNotRecreateKeyOrOverwriteCiphertext() {
        vault.save("alpha", "fake-lost-key-token")
        val original = vault.recordFile("alpha").readBytes()
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        store.deleteEntry(vault.alias("alpha"))
        expectCode("key_unavailable") { vault.load("alpha") }
        expectCode("key_unavailable") { vault.save("alpha", "fake-replacement-token") }
        assertArrayEquals(original, vault.recordFile("alpha").readBytes())
        assertFalse(store.containsAlias(vault.alias("alpha")))
    }

    @Test
    fun ciphertextCopiedAcrossSlotsCannotBeRead() {
        vault.save("alpha", "fake-alpha-token")
        vault.save("beta", "fake-beta-token")
        vault.recordFile("beta").writeBytes(vault.recordFile("alpha").readBytes())
        expectCode("corrupted") { vault.load("beta") }
        assertEquals("fake-alpha-token", vault.load("alpha"))
    }

    @Test
    fun failedAtomicUpdateAndInvalidInputKeepOldValue() {
        vault.save("alpha", "fake-old-token")
        val original = vault.recordFile("alpha").readBytes()
        val failing = AndroidSecretVault(context, namespace) { throw IOException("fixed test failure") }
        expectCode("io_error") { failing.save("alpha", "fake-new-token") }
        assertArrayEquals(original, vault.recordFile("alpha").readBytes())
        assertEquals("fake-old-token", vault.load("alpha"))
        expectCode("invalid_secret") { vault.save("alpha", "fake token") }
        expectCode("invalid_secret") { vault.save("alpha", "x".repeat(MAX_SECRET_BYTES + 1)) }
        expectCode("invalid_slot") { vault.save("../alpha", "fake-token") }
        assertArrayEquals(original, vault.recordFile("alpha").readBytes())
        assertEquals("fake-old-token", vault.load("alpha"))
    }
}
