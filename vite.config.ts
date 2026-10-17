import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { devBridge } from "./devserver/bridge.ts";
import pkg from "./package.json" with { type: "json" };

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ mode }) => ({
  // The version the About page and the update check compare against.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), devBridge({ root: import.meta.dirname, env: loadEnv(mode, import.meta.dirname, "DEV_LLM_") })],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/target/**", "**/.cache/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "es2022" },
  test: { include: ["src/**/*.test.ts", "devserver/**/*.test.ts"] },
}));
