/**
 * web/src/components/AgentKeyGate.tsx — the one-time key prompt.
 *
 * The browser must present an X-Agent-Key to POST proposals and to mint stream
 * tickets. There is no login to build here: the key IS the credential, it lives
 * in localStorage, and once set the gate disappears for good rather than
 * decorating every screen with a banner about it.
 */
import { useState } from "react";
import { getAgentKey, hasAgentKey, setAgentKey } from "../lib/config.js";
import { Button, Field, inputClass } from "./ui.js";

/** The seeded demo identities, so a fresh box needs no copy-paste from docs. */
const SUGGESTED = [
  { key: "gak_buyer_test_key_0001", label: "Test buyer" },
  { key: "gak_polite_demo_key_0001", label: "Polite buyer" },
] as const;

export function AgentKeyGate({ children }: { children: React.ReactNode }): JSX.Element {
  const [key, setKey] = useState(getAgentKey);
  const [ready, setReady] = useState(hasAgentKey);

  if (ready) return <>{children}</>;

  const commit = (k: string): void => {
    if (k.trim() === "") return;
    setAgentKey(k.trim());
    setReady(true);
  };

  return (
    <div className="mx-auto max-w-sm pt-20">
      <h1 className="text-[18px] font-semibold tracking-tight text-ink">Connect an agent key</h1>
      <p className="mt-1.5 text-[12px] leading-relaxed text-mute">
        Requests to the control plane are authenticated per agent. The key is kept in this
        browser only — use a disposable test-mode key.
      </p>

      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          commit(key);
        }}
      >
        <Field label="Agent key">
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="gak_…"
            autoComplete="off"
            className={`${inputClass} font-mono`}
          />
        </Field>
        <Button variant="primary" type="submit" className="w-full">
          Connect
        </Button>
      </form>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-edge pt-4">
        <span className="text-[11px] text-mute">Seeded:</span>
        {SUGGESTED.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => {
              setKey(s.key);
              commit(s.key);
            }}
            className="rounded-md border border-edge px-2 py-1 text-[11px] text-ink-muted transition-colors hover:border-edge-bright hover:text-ink"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
