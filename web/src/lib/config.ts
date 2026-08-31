/**
 * web/src/lib/config.ts — runtime config for the dashboard.
 *
 * The browser must present an X-Agent-Key (a buyer_agent key) to POST
 * proposals and to mint stream tickets (api/src/http/auth.ts). Per the M9
 * scope decision, the key is entered at runtime and kept in localStorage —
 * NOT baked into the build. This is a demo posture: any key held in a browser
 * is visible client-side, so use a disposable test-mode buyer_agent key.
 *
 * VITE_AGENT_KEY, if set at build time, is used ONLY as an initial seed when
 * localStorage is empty (convenience for a fixed demo box); the runtime field
 * always wins.
 */

const AGENT_KEY_STORAGE = "growthagent.agentKey";

/** Same-origin by default: Vite proxies /v1 + /webhooks to the API (:3000). */
export const API_BASE = "";

const seed =
  typeof import.meta.env.VITE_AGENT_KEY === "string" ? import.meta.env.VITE_AGENT_KEY : "";

export function getAgentKey(): string {
  try {
    const stored = window.localStorage.getItem(AGENT_KEY_STORAGE);
    if (stored !== null && stored.trim() !== "") return stored.trim();
  } catch {
    /* localStorage may be unavailable (private mode); fall through to seed */
  }
  return seed.trim();
}

export function setAgentKey(key: string): void {
  try {
    window.localStorage.setItem(AGENT_KEY_STORAGE, key.trim());
  } catch {
    /* non-fatal: the in-memory value in React state still drives this session */
  }
}

export function hasAgentKey(): boolean {
  return getAgentKey() !== "";
}
