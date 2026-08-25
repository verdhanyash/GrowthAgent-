import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// SSE hardening (frontend-events.md §2): dev proxy must pass text/event-stream
// through unmodified — no compression, no buffering transforms.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: false,
        // Vite's http-proxy does not buffer SSE by default; configure headers defensively.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              proxyRes.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
  optimizeDeps: {
    // DR-11: pre-bundle everything both screens import so the dep-optimizer
    // never triggers a mid-demo full-page reload on first lazy-route visit.
    include: ["react", "react-dom"],
  },
});
