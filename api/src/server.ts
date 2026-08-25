/**
 * GrowthAgent API entrypoint — M0 scaffold placeholder.
 *
 * Real composition root (routes, pipeline orchestrator, SSE hub) lands across
 * M1–M8 per ARCHITECTURE.md §16 repo layout. Kept runnable so the toolchain
 * proof (`npm run build && npm test`) is meaningful from day zero.
 */
import { SHARED_PACKAGE_VERSION } from "@growthagent/shared";

const PORT = Number(process.env.API_PORT ?? 3000);

export function greeting(): string {
  return `growthagent api ${SHARED_PACKAGE_VERSION} — gatekeeper pending (M1)`;
}

if (process.env.NODE_ENV !== "test") {
  // eslint-disable-next-line no-console
  console.log(greeting());
  // No listen() yet: nothing to serve until M2 wires routes.
  void PORT;
}
