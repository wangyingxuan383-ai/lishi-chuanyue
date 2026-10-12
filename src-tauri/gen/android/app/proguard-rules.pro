# Add project specific ProGuard rules here.
# Rust calls this component through JNI; R8 cannot discover those references.
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
# Rust-only JNI entry and native plugin are not discovered by R8 call analysis.
-keep class io.timejump.lishi.SecretStorePlugin { *; }
-keep class io.timejump.lishi.RustSecretStoreBridge { *; }
# Only Rust may open a selected SAF document through this worker-thread bridge.
-keep class io.timejump.lishi.RustFileAccessBridge { *; }
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
