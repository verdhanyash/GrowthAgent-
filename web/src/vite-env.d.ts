/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional build-time seed for the buyer_agent key (see lib/config.ts). */
  readonly VITE_AGENT_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
