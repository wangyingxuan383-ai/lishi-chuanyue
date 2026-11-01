package io.timejump.chuanyue.piprobe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.os.PowerManager;
import io.timejump.pi.NodeRuntime;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class AgentProbeService extends Service {
    private final AtomicBoolean started = new AtomicBoolean();
    private final Map<String, CompletableFuture<JSONObject>> pending = new ConcurrentHashMap<>();
    private ParcelFileDescriptor bridge;
    private OutputStreamWriter writer;
    private PowerManager.WakeLock wakeLock;
    private volatile boolean toolFailureSeen;
    private volatile int nodeExit = -1;
    private Thread nodeThread;
    private OwnedModelServer model;

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager notifications = (NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) notifications.createNotificationChannel(new NotificationChannel("pi-probe", "Pi 独立运行验证", NotificationManager.IMPORTANCE_LOW));
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "pi-probe") : new Notification.Builder(this);
        startForeground(191, builder.setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("Pi 独立运行验证").setContentText("仅运行自有模拟资料，不读取个人故事").build());
        wakeLock = ((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lishi:pi-probe");
        wakeLock.acquire(15 * 60 * 1000L);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (started.compareAndSet(false, true)) new Thread(this::check, "pi-probe-check").start();
        return START_NOT_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    private static void require(boolean condition, String message) { if (!condition) throw new IllegalStateException(message); }
    private static String read(File file) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (InputStream input = new FileInputStream(file)) { byte[] buffer = new byte[8192]; int count; while ((count = input.read(buffer)) >= 0) bytes.write(buffer, 0, count); }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }
    private static void write(File file, JSONObject value) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(value.toString(2).getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
    }
    private static long bytes(File file) {
        if (file.isFile()) return file.length();
        long total = 0; File[] children = file.listFiles();
        if (children != null) for (File child : children) total += bytes(child);
        return total;
    }
    private static boolean contains(File directory, String value) throws Exception {
        if (directory.isFile()) return read(directory).contains(value);
        File[] children = directory.listFiles();
        if (children != null) for (File child : children) if (contains(child, value)) return true;
        return false;
    }
    private void extract(String asset, File destination) throws Exception {
        String[] children = getAssets().list(asset);
        if (children != null && children.length > 0) {
            require(destination.mkdirs() || destination.isDirectory(), "Cannot prepare owned runtime directory");
            for (String child : children) extract(asset + "/" + child, new File(destination, child));
        } else {
            File parent = destination.getParentFile(); require(parent.mkdirs() || parent.isDirectory(), "Cannot prepare owned resource directory");
            try (InputStream input = getAssets().open(asset); FileOutputStream output = new FileOutputStream(destination)) { byte[] buffer = new byte[32768]; int count; while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count); }
        }
    }
    private synchronized void send(JSONObject value) throws Exception { writer.write(value.toString()); writer.write('\n'); writer.flush(); }
    private CompletableFuture<JSONObject> request(String method, JSONObject params) throws Exception {
        String id = UUID.randomUUID().toString(); CompletableFuture<JSONObject> future = new CompletableFuture<>(); pending.put(id, future);
        send(new JSONObject().put("id", id).put("method", method).put("params", params)); return future;
    }
    private JSONObject command(String method, JSONObject params) throws Exception { return request(method, params).get(45, TimeUnit.SECONDS); }
    private void receive() {
        try (BufferedReader input = new BufferedReader(new InputStreamReader(new FileInputStream(bridge.getFileDescriptor()), StandardCharsets.UTF_8))) {
            String line;
            while ((line = input.readLine()) != null) {
                JSONObject record = new JSONObject(line);
                if (record.optString("type").equals("tool_request")) {
                    JSONObject result = new JSONObject(ProbeGateway.invoke(record.toString()));
                    send(new JSONObject().put("method", "tool_result").put("params", new JSONObject().put("requestId", record.getString("requestId")).put("result", result)));
                } else if (record.optString("type").equals("response")) {
                    CompletableFuture<JSONObject> future = pending.remove(record.optString("id"));
                    if (future != null) {
                        if (record.optBoolean("ok")) future.complete(record.optJSONObject("data") == null ? new JSONObject() : record.getJSONObject("data"));
                        else future.completeExceptionally(new IllegalStateException(record.getJSONObject("error").optString("message")));
                    }
                } else if (record.optString("type").equals("event")) {
                    JSONObject event = record.optJSONObject("event");
                    if (event != null && event.optString("type").equals("tool_execution_end") && event.optString("toolName").equals("stage_clock") && event.optBoolean("isError")) toolFailureSeen = true;
                }
            }
            throw new IllegalStateException("Node transport ended");
        } catch (Exception error) { for (CompletableFuture<JSONObject> future : pending.values()) future.completeExceptionally(error); pending.clear(); }
    }
    private JSONObject tools() throws Exception {
        JSONObject empty = new JSONObject().put("type", "object").put("properties", new JSONObject()).put("additionalProperties", false);
        JSONObject clock = new JSONObject().put("type", "object").put("properties", new JSONObject().put("year", new JSONObject().put("type", "integer"))).put("required", new JSONArray().put("year")).put("additionalProperties", false);
        JSONObject edit = new JSONObject().put("type", "object").put("properties", new JSONObject().put("text", new JSONObject().put("type", "string"))).put("required", new JSONArray().put("text")).put("additionalProperties", false);
        return new JSONObject().put("tools", new JSONArray()
            .put(new JSONObject().put("name", "read_resource").put("label", "读取独立Rust资料").put("description", "读取独立验证资料").put("readOnly", true).put("parameters", empty))
            .put(new JSONObject().put("name", "stage_clock").put("label", "验证日期错误").put("description", "验证Rust的具体错误反馈").put("readOnly", false).put("parameters", clock))
            .put(new JSONObject().put("name", "stage_edit").put("label", "准备独立Rust草稿").put("description", "只写独立验证草稿，不写正式故事").put("readOnly", false).put("parameters", edit)));
    }
    private void check() {
        long began = android.os.SystemClock.elapsedRealtime(); JSONObject report = new JSONObject(); File resultDirectory = null;
        try {
            File directory = new File(getFilesDir(), "probe-" + UUID.randomUUID()); require(directory.mkdirs(), "Cannot create owned probe directory");
            resultDirectory = directory;
            report.put("runDirectory", directory.getName());
            File runtime = new File(directory, "runtime"); extract("pi-runtime", runtime);
            File bootstrap = new File(directory, "probe"); extract("probe", bootstrap);
            report.put("assetExtractionMs", android.os.SystemClock.elapsedRealtime() - began).put("runtimeResourceBytes", bytes(runtime));
            File session = new File(directory, "session"); require(session.mkdirs(), "Cannot create owned session");
            ProbeGateway.initialize(new File(directory, "rust-fixture").getAbsolutePath());
            int[] descriptors = NodeRuntime.createBridge(); bridge = ParcelFileDescriptor.adoptFd(descriptors[0]);
            writer = new OutputStreamWriter(new FileOutputStream(bridge.getFileDescriptor()), StandardCharsets.UTF_8);
            new Thread(this::receive, "pi-probe-rpc").start();
            long nodeBegan = android.os.SystemClock.elapsedRealtime();
            nodeThread = new Thread(() -> { nodeExit = NodeRuntime.run(new File(bootstrap, "bootstrap.mjs").getAbsolutePath(), directory.getAbsolutePath(), descriptors[1]); }, "pi-probe-node");
            nodeThread.start(); model = new OwnedModelServer(directory);
            JSONObject config = tools().put("directory", session.getAbsolutePath()).put("systemPrompt", "只处理独立模拟资料，解释与草稿分开。")
                .put("model", new JSONObject().put("id", "owned-pi-probe").put("protocol", "chat-completions").put("baseUrl", "http://127.0.0.1:" + model.port() + "/v1").put("apiKey", "pi-probe-local-only").put("inputTokens", 12000).put("contextWindowTokens", 12000).put("maxOutputTokens", 1024));
            JSONObject created = command("create", config);
            report.put("nodeCreateMs", android.os.SystemClock.elapsedRealtime() - nodeBegan).put("servicePid", android.os.Process.myPid()).put("runtimeChecks", new JSONObject(read(new File(directory, "runtime-checks.json"))));
            require(created.getJSONArray("tools").length() == 3, "Unexpected built-in tools enabled");
            JSONObject first = command("prompt", new JSONObject().put("text", "读取独立资料并准备草稿，同时验证日期失败。").put("taskId", "owned-probe-one"));
            require(model.count() == 3, "Unexpected first task requests");
            require(model.requestText(1).contains("青石桥书铺旧设定") && model.requestText(1).contains("owned-card") && model.requestText(1).contains("invalid_year"), "Source data or structured failure did not reach the model");
            require(toolFailureSeen, "Business failure was not reported as a failed tool");
            JSONObject state = new JSONObject(ProbeGateway.snapshot());
            require(state.getJSONArray("calls").length() == 3 && state.getString("draft").equals("独立Rust草稿"), "Node/Rust fixture round-trip failed");
            String sessionFile = first.getString("sessionFile");
            require(!read(new File(sessionFile)).contains("pi-probe-local-only"), "Credential persisted in session");
            command("close", new JSONObject());
            config.put("sessionFile", sessionFile); command("create", config);
            command("prompt", new JSONObject().put("text", "继续读取此前结果。").put("taskId", "owned-probe-two"));
            require(model.count() == 4 && model.requestText(3).contains("独立Rust草稿"), "Pi session did not restore tool context");
            CompletableFuture<JSONObject> running = request("prompt", new JSONObject().put("text", "等待取消验证。").put("taskId", "owned-probe-three"));
            require(model.awaitHeld(), "Owned cancellation stream did not start");
            command("abort", new JSONObject()); running.get(20, TimeUnit.SECONDS);
            require(model.count() == 5 && !command("inspect", new JSONObject()).getBoolean("streaming"), "Pi cancellation did not settle");
            command("close", new JSONObject());
            require(!contains(session, "pi-probe-local-only"), "Credential persisted after session restore or cancellation");
            report.put("ok", true).put("fixtureOnly", true).put("fullPiSdk", true).put("privateSocketpair", true).put("rustGateway", state)
                .put("toolErrorPreserved", true).put("sourceAndReferenceDelivered", true).put("sessionRestored", true).put("cancellationPassed", true).put("credentialNotPersisted", true)
                .put("mockRequests", model.count()).put("realRequests", 0).put("upstream", created.getJSONObject("upstream")).put("runDirectory", directory.getName());
        } catch (Throwable error) {
            try { report.put("ok", false).put("fixtureOnly", true).put("error", error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage())).put("mockRequests", model == null ? 0 : model.count()).put("realRequests", 0); } catch (Exception ignored) { }
        } finally {
            try { if (writer != null) writer.close(); } catch (Exception ignored) { }
            try { if (bridge != null) bridge.close(); } catch (Exception ignored) { }
            try { if (model != null) model.close(); } catch (Exception ignored) { }
            try { if (nodeThread != null) nodeThread.join(5000); } catch (Exception ignored) { }
            try {
                boolean runtimeExited = nodeThread == null || !nodeThread.isAlive();
                if (report.optBoolean("ok") && (!runtimeExited || nodeExit != 0)) report.put("ok", false).put("error", "The Node runtime did not exit cleanly");
                report.put("nodeExit", nodeExit).put("runtimeExited", runtimeExited).put("elapsedMs", android.os.SystemClock.elapsedRealtime() - began).put("sdkInt", Build.VERSION.SDK_INT).put("mainUiRequired", false).put("vmHwm", read(new File("/proc/self/status")).replaceAll("(?s).*?VmHWM:\\s*([^\\n]+).*", "$1"));
                if (resultDirectory != null) write(new File(resultDirectory, "probe-result.json"), report);
                write(new File(getFilesDir(), "probe-result.json"), report);
            } catch (Exception ignored) { }
            stopForeground(true); if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); stopSelf();
        }
    }
    @Override public void onDestroy() {
        try { if (bridge != null) bridge.close(); } catch (Exception ignored) { }
        if (nodeThread != null && nodeThread.isAlive()) NodeRuntime.abortRuntime();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
