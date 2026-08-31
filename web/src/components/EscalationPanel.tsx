/**
 * EscalationPanel — READ-ONLY view of a human-in-the-loop escalation. This build
 * is the buyer surface (scope: buyer flow + read-only trace); the merchant
 * decision UI lives in a future admin screen. We show the frozen proposed cart,
 * the reason codes, the TTL countdown, and — once it lands — the resolution.
 * No approve/reject buttons here by design.
 */
import { useEffect, useState } from "react";
import { formatPaise, type EventPayloadMap } from "@growthagent/shared";
import { bpsToPct, shortHash } from "../lib/format.js";
import { Chip, KV } from "./ui.js";

type Created = EventPayloadMap["escalation_created"];
type Resolved = EventPayloadMap["escalation_approved"];

function useCountdown(expiresAt: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}

export function EscalationPanel({ created, resolved }: { created: Created | null; resolved: Resolved | null }): JSX.Element | null {
  if (!created) return null;
  return <EscalationBody created={created} resolved={resolved} />;
}

function EscalationBody({ created, resolved }: { created: Created; resolved: Resolved | null }): JSX.Element {
  const secs = useCountdown(created.expires_at);
  const cart = created.proposed_cart;
  return (
    <div className="rounded-lg border-2 border-escalate bg-escalate/[0.06] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold uppercase tracking-wide text-escalate">Escalated to human</h3>
        {resolved ? (
          <Chip tone={resolved.decision === "APPROVED" ? "ok" : "bad"}>{resolved.decision}</Chip>
        ) : (
          <Chip tone={secs > 0 ? "escalate" : "bad"}>{secs > 0 ? `expires in ${secs}s` : "expired"}</Chip>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {created.reason_codes.map((r) => (
          <Chip key={r} tone="escalate">{r}</Chip>
        ))}
      </div>

      <dl className="mt-3 divide-y divide-edge/50">
        <KV k="lines">{cart.lines.length}</KV>
        <KV k="subtotal">{formatPaise(cart.subtotal_paise)}</KV>
        <KV k="discount">{bpsToPct(cart.discount_percent_bps)} · −{formatPaise(cart.discount_paise)}</KV>
        <KV k="total">{formatPaise(cart.total_paise)}</KV>
        <KV k="rule trace">{shortHash(created.rule_trace_ref.trace_digest)}</KV>
      </dl>

      {resolved && (
        <p className="mt-3 text-[12px] text-mute">
          decided by <span className="text-ink/90">{resolved.decided_by}</span> at {resolved.decided_at}
          {resolved.note && <> — “{resolved.note}”</>}
        </p>
      )}
    </div>
  );
}
