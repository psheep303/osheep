import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const BACKEND = process.env.VITE_API_PROXY ?? "http://127.0.0.1:4178";

export function frontendManualChunk(id: string): string | undefined {
  const normalizedId = id.replaceAll("\\", "/");
  if (normalizedId.includes("/node_modules/monaco-editor/")) return "monaco";
  if (normalizedId.includes("/node_modules/@xterm/")) return "xterm";
  if (
    normalizedId.includes("/node_modules/marked/") ||
    normalizedId.includes("/node_modules/dompurify/")
  ) {
    return "markdown";
  }
}

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks: frontendManualChunk,
      },
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
