package io.timejump.chuanyue

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import java.util.concurrent.Executors
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONException
import org.json.JSONObject

private const val DEFAULT_NAMESPACE = "io.timejump.chuanyue.secret.v1"
internal const val MAX_SECRET_BYTES = 4096
internal const val MAX_RECORD_BYTES = 32 * 1024

internal class SecretVaultException(val code: String) : Exception(code)

private fun failure(code: String): Nothing = throw SecretVaultException(code)

private fun validateSlot(slot: String) {
    if (slot.isEmpty() || slot.length > 64 || slot.any {
        !(it in 'a'..'z' || it in '0'..'9' || it == '_' || it == '-')
    }) failure("invalid_slot")
}

private fun validateSecretCharacters(secret: String) {
    if (secret.isEmpty() || secret.length > MAX_SECRET_BYTES) failure("invalid_secret")
    var index = 0
    while (index < secret.length) {
        val codepoint = Character.codePointAt(secret, index)
        if (codepoint in 0xD800..0xDFFF || Character.isISOControl(codepoint) ||
            Character.isWhitespace(codepoint) || Character.isSpaceChar(codepoint)) {
            failure("invalid_secret")
        }
        index += Character.charCount(codepoint)
    }
}

private fun encodeSecret(secret: String): ByteArray {
    validateSecretCharacters(secret)
    val bytes = secret.toByteArray(Charsets.UTF_8)
    if (bytes.isEmpty() || bytes.size > MAX_SECRET_BYTES) {
        bytes.fill(0)
        failure("invalid_secret")
    }
    return bytes
}

private fun decodeUtf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
    .onMalformedInput(CodingErrorAction.REPORT)
    .onUnmappableCharacter(CodingErrorAction.REPORT)
    .decode(ByteBuffer.wrap(bytes)).toString()

/** Ciphertext-only storage. All instances share a lock, including JNI reads. */
internal class AndroidSecretVault(
    context: Context,
    internal val namespace: String = DEFAULT_NAMESPACE,
    private val beforeCommit: (() -> Unit)? = null,
) {
    internal val directory = File(File(context.noBackupFilesDir, "lishi-secret-store-v1"), namespace)

    init {
        require(namespace.matches(Regex("[A-Za-z0-9_.-]{1,100}")))
    }

    internal fun alias(slot: String): String {
        validateSlot(slot)
        return "$namespace:$slot"
    }

    internal fun recordFile(slot: String): File {
        validateSlot(slot)
        return File(directory, "$slot.json")
    }

    private fun hasAnyRecord(slot: String): Boolean {
        val file = recordFile(slot)
        return file.exists() || File(file.path + ".bak").exists() || File(file.path + ".new").exists()
    }

    private fun ensureDirectory() {
        if (!directory.isDirectory && !directory.mkdirs()) failure("io_error")
    }

    private fun keyStore(): KeyStore = try {
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    } catch (_: Exception) {
        failure("unavailable")
    }

    private fun existingKey(store: KeyStore, slot: String): SecretKey? = try {
        if (!store.containsAlias(alias(slot))) null
        else (store.getKey(alias(slot), null) as? SecretKey) ?: failure("key_unavailable")
    } catch (error: SecretVaultException) {
        throw error
    } catch (_: Exception) {
        failure("key_unavailable")
    }

    private fun createKey(slot: String): SecretKey = try {
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias(slot),
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false)
                .build())
        }.generateKey()
    } catch (_: Exception) {
        failure("key_unavailable")
    }

    private fun aad(slot: String): ByteArray = "$namespace\u0000$slot\u00001".toByteArray(Charsets.UTF_8)

    fun exists(slot: String): Boolean = synchronized(LOCK) {
        val file = recordFile(slot)
        file.exists() || File(file.path + ".bak").exists()
    }

    fun save(slot: String, secret: String) = synchronized(LOCK) {
        validateSlot(slot)
        val plaintext = encodeSecret(secret)
        var createdKey = false
        var store: KeyStore? = null
        try {
            val activeStore = keyStore()
            store = activeStore
            ensureDirectory()
            var key = existingKey(activeStore, slot)
            if (key == null) {
                // A lost alias must not silently replace the key for existing ciphertext.
                if (hasAnyRecord(slot)) failure("key_unavailable")
                key = createKey(slot)
                createdKey = true
            }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(aad(slot))
            val encrypted = cipher.doFinal(plaintext)
            val nonce = cipher.iv
            if (nonce.size != 12) failure("key_unavailable")
            val record = JSONObject()
                .put("version", 1)
                .put("nonce", Base64.encodeToString(nonce, Base64.NO_WRAP))
                .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .toString().toByteArray(Charsets.UTF_8)
            if (record.size > MAX_RECORD_BYTES) failure("io_error")
            val atomic = AtomicFile(recordFile(slot))
            var output: FileOutputStream? = null
            try {
                output = atomic.startWrite()
                output.write(record)
                output.fd.sync()
                beforeCommit?.invoke()
                atomic.finishWrite(output)
                output = null
            } catch (_: Exception) {
                if (output != null) atomic.failWrite(output)
                failure("io_error")
            }
        } catch (error: SecretVaultException) {
            if (createdKey && !hasAnyRecord(slot)) {
                try { store?.deleteEntry(alias(slot)) } catch (_: Exception) { }
            }
            throw error
        } catch (_: KeyPermanentlyInvalidatedException) {
            failure("key_unavailable")
        } catch (_: GeneralSecurityException) {
            failure("key_unavailable")
        } catch (_: IOException) {
            failure("io_error")
        } finally {
            plaintext.fill(0)
        }
    }

    private fun readRecord(slot: String): ByteArray? {
        val atomic = AtomicFile(recordFile(slot))
        if (!hasAnyRecord(slot)) return null
        return try {
            atomic.openRead().use { input ->
                val buffer = ByteArray(MAX_RECORD_BYTES + 1)
                var count = 0
                while (count < buffer.size) {
                    val read = input.read(buffer, count, buffer.size - count)
                    if (read == -1) break
                    count += read
                }
                if (count > MAX_RECORD_BYTES || count == 0) failure("corrupted")
                buffer.copyOf(count)
            }
        } catch (error: SecretVaultException) {
            throw error
        } catch (_: IOException) {
            failure("io_error")
        }
    }

    fun load(slot: String): String? = synchronized(LOCK) {
        validateSlot(slot)
        if (!hasAnyRecord(slot)) return@synchronized null
        val key = existingKey(keyStore(), slot) ?: failure("key_unavailable")
        val recordBytes = readRecord(slot) ?: return@synchronized null
        try {
            val record = JSONObject(decodeUtf8(recordBytes))
            if (record.length() != 3 || record.opt("version") != 1) failure("corrupted")
            val nonceText = record.opt("nonce") as? String ?: failure("corrupted")
            val ciphertextText = record.opt("ciphertext") as? String ?: failure("corrupted")
            val nonce = Base64.decode(nonceText, Base64.NO_WRAP)
            val encrypted = Base64.decode(ciphertextText, Base64.NO_WRAP)
            if (nonce.size != 12 || encrypted.size !in 17..(MAX_SECRET_BYTES + 16)) failure("corrupted")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce))
            cipher.updateAAD(aad(slot))
            val plaintext = cipher.doFinal(encrypted)
            try {
                if (plaintext.size !in 1..MAX_SECRET_BYTES) failure("corrupted")
                val secret = decodeUtf8(plaintext)
                try { validateSecretCharacters(secret) } catch (_: SecretVaultException) { failure("corrupted") }
                secret
            } finally {
                plaintext.fill(0)
            }
        } catch (error: SecretVaultException) {
            throw error
        } catch (_: AEADBadTagException) {
            failure("corrupted")
        } catch (_: KeyPermanentlyInvalidatedException) {
            failure("key_unavailable")
        } catch (_: UnrecoverableKeyException) {
            failure("key_unavailable")
        } catch (_: GeneralSecurityException) {
            failure("key_unavailable")
        } catch (_: JSONException) {
            failure("corrupted")
        } catch (_: CharacterCodingException) {
            failure("corrupted")
        } catch (_: IllegalArgumentException) {
            failure("corrupted")
        }
    }

    fun delete(slot: String) = synchronized(LOCK) {
        validateSlot(slot)
        val store = keyStore()
        val atomic = AtomicFile(recordFile(slot))
        atomic.delete()
        // Keep the key if file removal failed, rather than orphaning readable ciphertext.
        if (hasAnyRecord(slot)) failure("io_error")
        try { store.deleteEntry(alias(slot)) } catch (_: Exception) { failure("key_unavailable") }
    }

    companion object {
        private val LOCK = Any()
    }
}

private fun errorReply(code: String): JSObject = JSObject().put("ok", false).put("code", code)

@TauriPlugin
class SecretStorePlugin(activity: Activity) : Plugin(activity) {
    private val vault = AndroidSecretVault(activity.applicationContext)
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "lishi-secret-store").apply { isDaemon = true }
    }

    private fun execute(invoke: Invoke, action: () -> JSObject) {
        try {
            executor.execute {
                val reply = try { action() }
                    catch (error: SecretVaultException) { errorReply(error.code) }
                    catch (_: Exception) { errorReply("unavailable") }
                // No exception object is passed to reject(): it would be logged by Tauri.
                invoke.resolve(reply)
            }
        } catch (_: Exception) {
            invoke.resolve(errorReply("unavailable"))
        }
    }

    @Command
    fun save(invoke: Invoke) = execute(invoke) {
        val args = invoke.getArgs()
        val slot = args.opt("slot") as? String ?: failure("invalid_slot")
        val secret = args.opt("secret") as? String ?: failure("invalid_secret")
        vault.save(slot, secret)
        JSObject().put("ok", true)
    }

    @Command
    fun delete(invoke: Invoke) = execute(invoke) {
        val slot = invoke.getArgs().opt("slot") as? String ?: failure("invalid_slot")
        vault.delete(slot)
        JSObject().put("ok", true)
    }

    @Command
    fun status(invoke: Invoke) = execute(invoke) {
        val slot = invoke.getArgs().opt("slot") as? String ?: failure("invalid_slot")
        JSObject().put("ok", true).put("exists", vault.exists(slot))
    }
}

/** JNI-only bridge: never annotate this method with @Command or expose it in Rust IPC. */
object RustSecretStoreBridge {
    @JvmStatic
    fun loadForRust(context: Context, slot: String): String = try {
        val secret = AndroidSecretVault(context.applicationContext).load(slot)
        JSObject().put("ok", true).put("secret", secret).toString()
    } catch (error: SecretVaultException) {
        errorReply(error.code).toString()
    } catch (_: Exception) {
        errorReply("unavailable").toString()
    }
}
