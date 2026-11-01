# Android Agent native service

This crate provides `liblishi_agent_host.so` for the application's dedicated
`:agent` service. It does not initialize Tauri, Wry or the legacy story Engine.

`AgentNative.nativeInitialize` must run on a service worker, before Java starts
Node. The Rust socket descriptor transfers ownership to Rust on entry, including
error paths; Java must not adopt or close the same descriptor. The other socket
end belongs exclusively to the Node embedder.

The supplied database directory must equal the Application Context's canonical
`applicationInfo.dataDir`. Runtime resources must remain beneath that directory
and pass the complete native manifest check. SQLite migration and backups use
the shared `SqlStore` implementation. No task is automatically recovered or run.

Control requests use positive request IDs. Replies call
`AgentNative.onNativeReply(handle, requestId, responseJson)`, with
`{ok:true,data:...}` or an error code and shared player-facing validation
message. Native infrastructure failures use fixed generic diagnostics. ID zero carries committed-story
notifications. Activity transitions call `onNativeActivity(handle, active)`.
These callbacks never carry credential configuration. JSON is bounded to 8 MiB,
matching the Android IPC layer's bounded payload/file handling. A worker panic
replies with an interrupted result and retires the pending request identifier;
it does not silently leave the Java waiter unresolved.

Model resolution reloads saved profiles and credential bindings for each task.
It reuses the application's existing credential authorization and protected
secret types. Keys are read through the cached JNI-only `RustSecretStoreBridge`
with Application Context; no Activity or plaintext getter IPC is required.
Provider routing and application proxy/certificate parity require their separate
integration checks; native initialization alone does not verify those behaviors.

The common `AgentHostService` owns the persistent Node connection. Completing a
task only detaches its Pi session. Closing a UI subscription does not call native
shutdown. Explicit shutdown retires the opaque native handle and invokes the
common service's closing barrier; a Node exit closes the transport without
automatically restarting or replaying tasks. Java must use a fresh service
process before restarting a fully torn-down Node runtime.
