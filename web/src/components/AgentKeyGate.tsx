/**
 * AgentKeyGate — the runtime agent-key field. Per the confirmed demo posture the
 * key is NOT baked into the build; it lives in localStorage (config.ts) and is
 * entered here at runtime. We show the visible-client-side caveat honestly. When
 * a key is present, children render; otherwise the gate blocks the buyer surface.
 */
import { useState } from "react";
import { getAgentKey, hasAgentKey, setAgentKey } from "../lib/config.js";
import { Panel } from "./ui.js";

export function AgentKeyGate({ children }: { children: React.ReactNode }): JSX.Element {
  const [key, setKey] = useState(getAgentKey);
  const [saved, setSaved] = useState(hasAgentKey);

  if (saved) {
    return (
      <div>
        <div className="mb-4 flex items-center justify-between rounded border border-edge bg-panel px-3 py-2 text-[12px]">
          <span className="text-mute">agent key: <span className="font-mono text-ok">•••• configured</span></span>
          <button
            type="button"
            onClick={() => {
              setAgentKey("");
              setKey("");
              setSaved(false);
            }}
            className="rounded px-2 py-0.5 text-mute hover:bg-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            change
          </button>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md pt-16">
      <Panel title="Agent key required">
        <p className="text-[13px] text-mute">
          This buyer surface authenticates every call with <span className="font-mono text-ink/90">X-Agent-Key</span>. Paste a
          <span className="font-mono text-ink/90"> buyer_agent</span> key to continue.
        </p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim() === "") return;
            setAgentKey(key.trim());
            setSaved(true);
          }}
        >
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="agent key"
            className="flex-1 rounded border border-edge bg-bg px-3 py-2 font-mono text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <button type="submit" className="rounded bg-accent/20 px-4 py-2 text-[13px] font-semibold text-accent hover:bg-accent/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            Use key
          </button>
        </form>
        <p className="mt-3 text-[11px] text-warn/90">
          ⚠ Demo posture: the key is stored in this browser's localStorage and is visible client-side. Do not use a production secret.
        </p>
      </Panel>
    </div>
  );
}
