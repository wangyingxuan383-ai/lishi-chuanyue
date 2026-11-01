import groovy.json.JsonSlurper
import java.io.File
import java.security.MessageDigest
import com.android.build.api.dsl.ApplicationExtension
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.TaskAction

// Prepared by scripts/pi-host/prepare-android-app.mjs; no downloads or native
// builds are launched from Gradle configuration or from the installed app.
val piAppRuntime = providers.gradleProperty("piAppRuntimeDirectory")
    .map { File(it).also { source -> check(source.isAbsolute) { "Pi runtime directory must be absolute" } } }
    .orElse(layout.projectDirectory.dir("../../../../.cache/pi-app-android/current").asFile)
val piAssets = layout.buildDirectory.dir("generated/pi-runtime/assets")
val piNative = layout.buildDirectory.dir("generated/pi-runtime/jniLibs")

abstract class VerifyPiRuntime : DefaultTask() {
    @get:InputDirectory
    abstract val runtimeDirectory: DirectoryProperty

private fun piSha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(65536)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

    @TaskAction
    fun verify() {
        val root = runtimeDirectory.get().asFile.canonicalFile
        val marker = File(root, "receipt.json")
        check(marker.isFile) { "Prepare the complete Pi application runtime and pass -PpiAppRuntimeDirectory=<directory>" }
        val receipt = JsonSlurper().parse(marker) as Map<*, *>
        check(receipt["ready"] == true && receipt["commit"] == "973b74c55fcf096ad5976f8d8850c147ee2e62d4"
            && receipt["nodeVersion"] == "24.19.0" && receipt["minSdk"] == 24
            && receipt["targetSdk"] == 36 && receipt["pageSize"] == 16384 && receipt["abi"] == "arm64-v8a") {
            "Pi native build receipt does not match the approved platform"
        }
        fun verifyFile(base: File, item: Map<*, *>) {
            val name = item["path"] as? String ?: error("Invalid runtime path")
            check(!name.startsWith('/') && !name.contains('\\') && name.split('/').none { it.isEmpty() || it == "." || it == ".." })
            val artifact = File(base, name).canonicalFile
            check(artifact.toPath().startsWith(base.canonicalFile.toPath()) && artifact.isFile)
            check(artifact.length() == (item["bytes"] as Number).toLong() && piSha256(artifact) == item["sha256"]) {
                "Pi build artifact changed: $name"
            }
        }
        val libraries = (receipt["libraries"] as List<*>).map { it as Map<*, *> }
        check(libraries.map { it["path"] }.toSet() == setOf(
            "jniLibs/arm64-v8a/libnode.so", "jniLibs/arm64-v8a/liblishi_node_embed.so",
            "jniLibs/arm64-v8a/libc++_shared.so", "jniLibs/arm64-v8a/liblishi_agent_host.so"))
        libraries.forEach { verifyFile(root, it) }
        val runtime = File(root, "assets/pi-runtime")
        val manifestFile = File(runtime, "manifest.json")
        check(piSha256(manifestFile) == receipt["manifestSha256"])
        val manifest = JsonSlurper().parse(manifestFile) as Map<*, *>
        check(manifest["built"] == true && manifest["fullCodingAgent"] == true
            && manifest["commit"] == receipt["commit"] && manifest["nodeVersion"] == receipt["nodeVersion"])
        val files = (manifest["files"] as List<*>).map { it as Map<*, *> }
        check(files.isNotEmpty() && files.map { it["path"] }.distinct().size == files.size)
        files.forEach { verifyFile(runtime, it) }
        val notices = File(root, "assets/native-notices")
        val noticeManifest = JsonSlurper().parse(File(notices, "manifest.json")) as Map<*, *>
        check(noticeManifest["nodeVersion"] == receipt["nodeVersion"])
        (noticeManifest["files"] as Map<*, *>).forEach { (name, entry) ->
            val item = (entry as Map<*, *>).toMutableMap()
            item["path"] = name
            verifyFile(notices, item)
        }
    }
}

val verifyPiRuntime = tasks.register<VerifyPiRuntime>("verifyPiAppRuntime") {
    group = "verification"
    runtimeDirectory.set(layout.dir(piAppRuntime))
}

val stagePiAssets = tasks.register<Sync>("stagePiAppAssets") {
    dependsOn(verifyPiRuntime)
    from(piAppRuntime.map { File(it, "assets") }) { include("pi-runtime/**", "native-notices/**") }
    into(piAssets)
}
val stagePiNative = tasks.register<Sync>("stagePiAppNative") {
    dependsOn(verifyPiRuntime)
    from(piAppRuntime.map { File(it, "jniLibs") }) { include("arm64-v8a/*.so") }
    into(piNative)
}
extensions.configure<ApplicationExtension> {
    sourceSets.getByName("main").assets.srcDir(piAssets.get().asFile)
    sourceSets.getByName("main").jniLibs.srcDir(piNative.get().asFile)
}
tasks.configureEach {
    if (name.startsWith("merge") && name.endsWith("Assets")) dependsOn(stagePiAssets)
    if (name.startsWith("merge") && name.endsWith("JniLibFolders")) dependsOn(stagePiNative)
    // Release lint/model tasks also inspect generated source-set directories.
    // Android SourceSet rejects providers, so declare their producers explicitly.
    if (name.contains("lint", ignoreCase = true)) dependsOn(stagePiAssets, stagePiNative)
}
