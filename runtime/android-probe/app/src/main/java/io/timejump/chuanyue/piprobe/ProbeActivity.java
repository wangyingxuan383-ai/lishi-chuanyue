package io.timejump.chuanyue.piprobe;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.view.WindowManager;
import android.widget.TextView;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;

public final class ProbeActivity extends Activity {
    private final Handler handler = new Handler();
    private TextView status;
    private final Runnable update = new Runnable() {
        @Override public void run() {
            try {
                File file = new File(getFilesDir(), "probe-result.json");
                if (file.isFile()) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    try (FileInputStream input = new FileInputStream(file)) {
                        byte[] buffer = new byte[4096]; int count;
                        while ((count = input.read(buffer)) >= 0) bytes.write(buffer, 0, count);
                    }
                    status.setText("独立验证结果（不含个人故事）\n\n" + new String(bytes.toByteArray(), StandardCharsets.UTF_8));
                }
            } catch (Exception ignored) { }
            handler.postDelayed(this, 1000);
        }
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        status = new TextView(this); status.setPadding(28, 48, 28, 28); status.setTextSize(16);
        status.setText("Pi 单 APK 独立验证\n\n只使用应用自有模拟资料与模型，不读取或修改正式故事。\n完整结果将保存到本验证应用内部。\n");
        setContentView(status);
        handler.post(update);
        if (getIntent().getBooleanExtra("run", false)) {
            File oldResult = new File(getFilesDir(), "probe-result.json");
            if (oldResult.exists() && !oldResult.delete()) throw new IllegalStateException("Cannot clear the previous owned probe result");
            Intent service = new Intent(this, AgentProbeService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(service); else startService(service);
        }
    }
    @Override protected void onDestroy() { handler.removeCallbacksAndMessages(null); super.onDestroy(); }
}
