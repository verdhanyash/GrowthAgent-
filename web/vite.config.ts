import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// SSE hardening (frontend-events.md §2): dev proxy must pass text/event-stream
// through unmodified — no compression, no buffering transforms. The real API
// surface lives under /v1 (buyer routes + SSE stream) and /webhooks (settlement
// provider callbacks) — see api route recon; there is no /api prefix.
const passThroughSse = (proxy: {
  on: (e: "proxyRes", cb: (res: { headers: Record<string, string | string[] | undefined> }) => void) => void;
}) => {
  proxy.on("proxyRes", (proxyRes) => {
    const ct = proxyRes.headers["content-type"];
    if (typeof ct === "string" && ct.includes("text/event-stream")) {
      proxyRes.headers["cache-control"] = "no-cache, no-transform";
      proxyRes.headers["x-accel-buffering"] = "no";
    }
  });
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: "http://localhost:3000", changeOrigin: false, configure: passThroughSse },
      "/webhooks": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
  optimizeDeps: {
    // DR-11: pre-bundle everything the screens import so the dep-optimizer
    // never triggers a mid-demo full-page reload on first lazy-route visit.
    include: ["react", "react-dom", "react-router-dom", "@tanstack/react-query"],
  },
});
