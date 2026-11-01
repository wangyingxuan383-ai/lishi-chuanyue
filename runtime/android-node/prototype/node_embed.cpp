// Thin JNI embedder based on Node 24.19.0's documented C++ embedder API.
// This isolated prototype is not registered in the application.
#include <android/log.h>
#include <jni.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "node.h"
#include "uv.h"

namespace {
std::atomic<bool> started{false};
std::mutex environment_mutex;
node::Environment* active_environment = nullptr;

void throw_java(JNIEnv* env, const char* message) {
  jclass exception = env->FindClass("java/lang/IllegalStateException");
  if (exception != nullptr) env->ThrowNew(exception, message);
}

bool utf8(JNIEnv* env, jstring input, std::string* output) {
  if (input == nullptr) return false;
  const char* value = env->GetStringUTFChars(input, nullptr);
  if (value == nullptr) return false;
  *output = value;
  env->ReleaseStringUTFChars(input, value);
  return !output->empty() && (*output)[0] == '/' && output->find('\0') == std::string::npos;
}
}  // namespace

extern "C" JNIEXPORT jintArray JNICALL
Java_io_timejump_pi_NodeRuntime_createBridge(JNIEnv* env, jclass) {
  int descriptors[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, descriptors) != 0) {
    throw_java(env, "Cannot create the private Agent socketpair");
    return nullptr;
  }
  jintArray result = env->NewIntArray(2);
  if (result == nullptr) {
    close(descriptors[0]); close(descriptors[1]);
    return nullptr;
  }
  const jint values[] = {descriptors[0], descriptors[1]};
  env->SetIntArrayRegion(result, 0, 2, values);
  return result;
}

extern "C" JNIEXPORT jint JNICALL
Java_io_timejump_pi_NodeRuntime_run(JNIEnv* env, jclass, jstring entry_path,
                                    jstring working_directory, jint protocol_fd) {
  std::string entry, cwd;
  if (!utf8(env, entry_path, &entry) || !utf8(env, working_directory, &cwd) || protocol_fd < 0) {
    throw_java(env, "The Agent entry, working directory and private transport are required");
    return 1;
  }
  bool expected = false;
  if (!started.compare_exchange_strong(expected, true)) {
    throw_java(env, "A finished Node runtime requires a fresh Agent service process");
    return 1;
  }
  // This changes only the dedicated :agent process. The gateway must use absolute paths.
  if (uv_chdir(cwd.c_str()) != 0) {
    throw_java(env, "The private Agent working directory is unavailable");
    return 1;
  }
  std::vector<std::string> args = {"lishi-agent", entry, "--transport-fd", std::to_string(protocol_fd)};
  auto initialization = node::InitializeOncePerProcess(args, {
      node::ProcessInitializationFlags::kNoInitializeV8,
      node::ProcessInitializationFlags::kNoInitializeNodeV8Platform,
      node::ProcessInitializationFlags::kDisableNodeOptionsEnv,
      node::ProcessInitializationFlags::kNoDefaultSignalHandling,
      node::ProcessInitializationFlags::kNoStdioInitialization,
      node::ProcessInitializationFlags::kNoParseGlobalDebugVariables});
  if (initialization->early_return()) return initialization->exit_code();

  auto platform = node::MultiIsolatePlatform::Create(4);
  v8::V8::InitializePlatform(platform.get());
  v8::V8::Initialize();
  int result = 1;
  {
    std::vector<std::string> errors;
    auto setup = node::CommonEnvironmentSetup::Create(platform.get(), &errors,
        initialization->args(), initialization->exec_args());
    if (setup) {
      auto* isolate = setup->isolate();
      v8::Locker locker(isolate);
      v8::Isolate::Scope isolate_scope(isolate);
      v8::HandleScope handle_scope(isolate);
      v8::Context::Scope context_scope(setup->context());
      int explicit_exit = -1;
      node::SetProcessExitHandler(setup->env(), [&](node::Environment* instance, int code) {
        explicit_exit = code;
        node::Stop(instance);
      });
      {
        std::lock_guard<std::mutex> guard(environment_mutex);
        active_environment = setup->env();
      }
      // Use Node's normal entry loader: ESM imports and relative SDK resources retain their paths.
      const auto loaded = node::LoadEnvironment(setup->env(), "require('node:module').runMain();");
      if (!loaded.IsEmpty()) result = node::SpinEventLoop(setup->env()).FromMaybe(1);
      {
        std::lock_guard<std::mutex> guard(environment_mutex);
        active_environment = nullptr;
      }
      node::Stop(setup->env());
      if (explicit_exit >= 0) result = explicit_exit;
    } else {
      // Avoid logging arbitrary provider or user content from bootstrap errors.
      __android_log_write(ANDROID_LOG_ERROR, "LishiAgent", "Node environment initialization failed");
    }
  }
  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  node::TearDownOncePerProcess();
  return result;
}

extern "C" JNIEXPORT void JNICALL
Java_io_timejump_pi_NodeRuntime_abortRuntime(JNIEnv*, jclass) {
  // Last-resort runtime cancellation. Normal task stop must first use Pi session.abort().
  std::lock_guard<std::mutex> guard(environment_mutex);
  if (active_environment != nullptr) node::Stop(active_environment);
}
