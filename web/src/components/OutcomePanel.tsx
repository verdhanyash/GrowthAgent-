/**
 * web/src/components/OutcomePanel.tsx — the authoritative answer.
 *
 * Everything else on the trace screen is narration folded from a stream; this is
 * the signed terminal outcome from the poll, and it is the only thing here that
 * money depends on. So it gets the space, and it gets the arithmetic check —
 * subtotal − discount = total, recomputed client-side in integer paise, printed
 * as a verdict rather than assumed.
 */
import {
  arithmeticConsistent,
  formatPaise,
  type CartMandate,
  type ProposalStatusResponse,
} from "@growthagent/shared";
import { Chip, DataTable, KV, Mono, Panel } from "./ui.js";
import { formatReason, formatFailureStage } from "../lib/format.js";

function MandateCard({ m }: { m: CartMandate }): JSX.Element {
  const ok = arithmeticConsistent(m);

  return (
    <div className="space-y-6">
      <DataTable<CartMandate["items"][number]>
        rows={m.items}
        rowKey={(it) => it.sku}
        columns={[
          {
            header: "Item",
            cell: (it) => (
              <div>
                <div className="text-[12px] text-ink">{it.title}</div>
                <div className="text-[10px] text-mute">{it.sku}</div>
              </div>
            ),
          },
          { header: "Qty", numeric: true, cell: (it) => it.qty },
          { header: "Unit", numeric: true, cell: (it) => formatPaise(it.unit_price_paise) },
          {
            header: "Line",
            numeric: true,
            cell: (it) => formatPaise(it.unit_price_paise * it.qty),
          },
        ]}
      />

      <div className="grid gap-4 border-t border-edge pt-5 sm:grid-cols-4">
        <div>
          <div className="text-[11px] text-mute">Subtotal</div>
          <div className="mt-0.5 font-mono text-[14px] text-ink">
            {formatPaise(m.subtotal_paise)}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-mute">Discount {m.discount_pct}%</div>
          <div className="mt-0.5 font-mono text-[14px] text-ok-bright">
            −{formatPaise(m.discount_paise)}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-mute">Total</div>
          <div className="mt-0.5 font-mono text-[14px] font-semibold text-ink">
            {formatPaise(m.total_paise)}
          </div>
        </div>
        <div className="flex items-end">
          <Chip tone={ok ? "ok" : "bad"} title="Integer-paise recomputation of the signed totals">
            {ok ? "arithmetic consistent" : "arithmetic mismatch"}
          </Chip>
        </div>
      </div>

      <dl className="grid gap-x-8 border-t border-edge pt-3 sm:grid-cols-2">
        <KV k="Mandate">
          <Mono value={m.mandate_id} truncate className="max-w-[180px]" />
        </KV>
        <KV k="Cart hash">
          <Mono value={m.cart_hash} truncate className="max-w-[180px]" />
        </KV>
        <KV k="Merchant signature">
          <Mono value={m.merchant_sig} truncate className="max-w-[180px]" />
        </KV>
        <KV k="Valid until">{new Date(m.expires_at).toLocaleTimeString()}</KV>
      </dl>
    </div>
  );
}

const TONE = {
  APPROVED: "ok",
  DECLINED: "bad",
  ESCALATED: "escalate",
  FAILED: "warn",
} as const;

export function OutcomePanel({
  poll,
}: {
  poll?: ProposalStatusResponse | null;
}): JSX.Element | null {
  if (poll === undefined || poll === null || poll.status !== "TERMINAL") return null;

  const out = (poll as Extract<ProposalStatusResponse, { status: "TERMINAL" }>).outcome;

  return (
    <Panel
      tone={TONE[out.outcome]}
      title="Outcome"
      subtitle="The signed, authoritative record — not the stream's narration."
      right={<Chip tone={TONE[out.outcome]}>{out.outcome.toLowerCase()}</Chip>}
    >
      {out.outcome === "APPROVED" && (
        <div className="space-y-6">
          <MandateCard m={out.cart_mandate} />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-5">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-mute">
              <span>{out.settlement.provider} order</span>
              <Mono value={out.settlement.razorpay_order_id} truncate className="max-w-[180px]" />
            </div>
            <Chip tone={out.settlement.payment_status === "PAID" ? "ok" : "default"}>
              {out.settlement.payment_status.replace(/_/g, " ").toLowerCase()}
            </Chip>
          </div>
        </div>
      )}

      {out.outcome === "DECLINED" && (
        <ul className="space-y-2">
          {out.decline_reasons.map((r, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
              <span className="font-mono text-bad-bright">{r.rule_id.replace(/^GK-/, "")}</span>
              <span className="text-ink-muted">{r.message}</span>
            </li>
          ))}
        </ul>
      )}

      {out.outcome === "ESCALATED" && (
        <dl className="grid gap-x-8 sm:grid-cols-2">
          <KV k="Approval">
            <Mono value={out.approval_request.approval_id} truncate className="max-w-[180px]" />
          </KV>
          <KV k="Reason">{out.approval_request.reason.replace(/_/g, " ").toLowerCase()}</KV>
          <KV k="Expires">{new Date(out.expires_at).toLocaleTimeString()}</KV>
        </dl>
      )}

      {out.outcome === "FAILED" && (
        <div className="space-y-1.5 text-[12px]">
          <p className="text-ink-muted">
            Terminated during <span className="font-mono font-medium text-ink">{formatFailureStage(out.failure.stage)}</span> —{" "}
            <span className="font-medium text-ink">{formatReason(out.failure.reason)}</span>
          </p>
          <p className="text-[11px] text-mute">
            {out.failure.retryable
              ? "Retryable: the same request can be submitted again."
              : "Not retryable. No money moved."}
          </p>
        </div>
      )}
    </Panel>
  );
}
