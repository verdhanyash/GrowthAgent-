/**
 * OutcomePanel + CartMandateCard — the AUTHORITATIVE terminal result, taken from
 * the poll body (GET /v1/carts/proposals/:txId), not the SSE stream. The stream
 * is the live narration; this is the signed, verifiable end state. On APPROVED we
 * render the merchant-signed CartMandate and run the client-side arithmetic check
 * (arithmeticConsistent is pure/crypto-free; the HMAC needs the merchant secret,
 * which a buyer surface deliberately does not hold — shown as evidence, not
 * re-verified here). DECLINED lists the deterministic rule reasons; ESCALATED and
 * FAILED render their own honest states.
 */
import {
  arithmeticConsistent,
  formatPaise,
  type CartMandate,
  type ProposalStatusResponse,
} from "@growthagent/shared";
import { shortHash } from "../lib/format.js";
import { Chip, KV, Mono, Panel } from "./ui.js";

function CartMandateCard({ m }: { m: CartMandate }): JSX.Element {
  const arithmeticOk = arithmeticConsistent(m);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] text-mute">mandate <Mono value={m.mandate_id} /></span>
        <Chip tone={arithmeticOk ? "ok" : "bad"} title="client-side integer-math self-consistency check">
          {arithmeticOk ? "✓ arithmetic consistent" : "✕ arithmetic mismatch"}
        </Chip>
      </div>

      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
            <th className="py-1 pr-2 font-medium">Item</th>
            <th className="py-1 pr-2 text-right font-medium">Qty</th>
            <th className="py-1 text-right font-medium">Unit</th>
          </tr>
        </thead>
        <tbody>
          {m.items.map((it) => (
            <tr key={it.sku} className="border-t border-edge/60">
              <td className="py-1 pr-2"><span className="text-ink">{it.title}</span> <span className="font-mono text-[11px] text-mute">{it.sku}</span></td>
              <td className="py-1 pr-2 text-right text-ink/90">{it.qty}</td>
              <td className="py-1 text-right text-ink/90">{formatPaise(it.unit_price_paise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="divide-y divide-edge/50">
        <KV k="subtotal">{formatPaise(m.subtotal_paise)}</KV>
        <KV k="discount">{m.discount_pct}% · −{formatPaise(m.discount_paise)}</KV>
        <KV k="total">{formatPaise(m.total_paise)} {m.currency}</KV>
        <KV k="cart hash">{shortHash(m.cart_hash)}</KV>
        <KV k="merchant sig">{shortHash(m.merchant_sig, 10, 4)}</KV>
        <KV k="expires">{m.expires_at}</KV>
      </dl>
    </div>
  );
}

/** Renders the terminal poll body. Returns null while still pending. */
export function OutcomePanel({ poll }: { poll: ProposalStatusResponse | null }): JSX.Element | null {
  // Pending's `status` is a plain string enum, so `status !== "TERMINAL"` can't
  // discriminate the union — key off the presence of `outcome` instead.
  if (!poll || !("outcome" in poll)) return null;
  const o = poll.outcome;

  if (o.outcome === "APPROVED") {
    return (
      <Panel tone="ok" title="Approved — signed cart mandate" right={<Chip tone="ok">{o.settlement.provider}</Chip>}>
        <CartMandateCard m={o.cart_mandate} />
        <dl className="mt-3 divide-y divide-edge/50 border-t border-edge/50">
          <KV k="payment"><Chip tone={o.settlement.payment_status === "PAID" ? "ok" : "warn"}>{o.settlement.payment_status}</Chip></KV>
          <KV k="razorpay order"><Mono value={o.settlement.razorpay_order_id} /></KV>
        </dl>
      </Panel>
    );
  }

  if (o.outcome === "DECLINED") {
    return (
      <Panel tone="bad" title="Declined — deterministic reasons">
        <ul className="space-y-2">
          {o.decline_reasons.map((r, i) => (
            <li key={i} className="rounded border border-bad/40 bg-bad/[0.06] px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] text-bad">{r.rule_id}</span>
                {r.reason_code && <Chip tone="bad">{r.reason_code}</Chip>}
              </div>
              <p className="mt-1 text-[13px] text-ink/90">{r.message}</p>
            </li>
          ))}
        </ul>
      </Panel>
    );
  }

  if (o.outcome === "ESCALATED") {
    const ar = o.approval_request;
    return (
      <Panel tone="escalate" title="Escalated — awaiting human approval">
        <dl className="divide-y divide-edge/50">
          <KV k="reason"><Chip tone="escalate">{ar.reason}</Chip></KV>
          <KV k="observed">{ar.band_context.observed}</KV>
          <KV k="threshold">{ar.band_context.threshold}</KV>
          <KV k="expires">{o.expires_at}</KV>
          <KV k="approval id"><Mono value={ar.approval_id} /></KV>
        </dl>
        <p className="mt-3 text-[12px] text-mute">A merchant operator must approve or reject this out-of-band. This buyer view is read-only.</p>
      </Panel>
    );
  }

  // FAILED — honest infra death.
  return (
    <Panel tone="bad" title="Failed">
      <dl className="divide-y divide-edge/50">
        <KV k="stage">{o.failure.stage}</KV>
        <KV k="reason">{o.failure.reason}</KV>
        <KV k="retryable"><Chip tone={o.failure.retryable ? "warn" : "bad"}>{o.failure.retryable ? "yes" : "no"}</Chip></KV>
      </dl>
    </Panel>
  );
}
