import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/manifest.json": "http://127.0.0.1:8000",
      "/sw.js": "http://127.0.0.1:8000",
      "/copilot-worker.js": "http://127.0.0.1:8000",
      "/explanation.html": "http://127.0.0.1:8000"
    }
  }
});
