import { defineConfig } from "vitest/config";

// Web unit tests. The pure reducer/parser tests need no DOM, but the
// useTransactionStream hook test drives a fake EventSource under jsdom.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
    globals: false,
  },
});
