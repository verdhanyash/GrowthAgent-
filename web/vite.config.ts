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

/**
 * The API the dev server proxies to. Defaults to the conventional local port, so
 * `npm run dev` is unchanged; override it to point a second front end at a
 * second API (running both side by side is how a change gets compared against
 * the version it replaces).
 */
const API_TARGET = process.env.API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/v1": { target: API_TARGET, changeOrigin: false, configure: passThroughSse },
      "/webhooks": { target: API_TARGET, changeOrigin: false },
    },
  },
  optimizeDeps: {
    // DR-11: pre-bundle everything the screens import so the dep-optimizer
    // never triggers a mid-demo full-page reload on first lazy-route visit.
    include: ["react", "react-dom", "react-router-dom", "@tanstack/react-query"],
  },
});
