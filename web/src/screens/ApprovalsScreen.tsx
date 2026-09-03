/**
 * web/src/screens/ApprovalsScreen.tsx — the human-in-the-loop queue.
 *
 * One card per escalation, and every card answers the three questions a reviewer
 * actually has: what tripped, what is in the cart, and how long is left. Nothing
 * else. (The previous version spent two side-by-side definition lists and five
 * chips per row on metadata that never changed a decision.)
 *
 * Approving settles the FROZEN proposal — the exact bytes minted at escalation
 * time, not a re-proposal — so the card shows that cart, not a live re-quote.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPaise, type ApprovalRequest } from "@growthagent/shared";
import { approveApproval, fetchApprovals, rejectApproval } from "../lib/admin-api.js";
import { Button, Chip, Empty, Mono, Page, Segmented, inputClass } from "../components/ui.js";

type Tab = "PENDING" | "RESOLVED";

const TABS: readonly { value: Tab; label: string }[] = [
  { value: "PENDING", label: "Waiting" },
  { value: "RESOLVED", label: "Decided" },
];

/** Minutes left before the approval self-expires to DECLINED. */
function ttl(expiresAt: string): { text: string; urgent: boolean } {
  const ms = Date.parse(expiresAt) - Date.now();
  if (ms <= 0) return { text: "expired", urgent: true };
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return { text: `${Math.floor(ms / 1000)}s left`, urgent: true };
  if (mins < 60) return { text: `${mins}m left`, urgent: mins < 5 };
  return { text: `${Math.floor(mins / 60)}h ${mins % 60}m left`, urgent: false };
}

/**
 * The frozen cart, read defensively — `proposed_cart_snapshot` is stored JSON
 * (the SettleableProposal), not a typed field, and its money key is
 * `total_amount_paise`. Both spellings are accepted so the card keeps working
 * either way rather than quietly rendering an em dash where a total belongs.
 */
function cartOf(snapshot: unknown): { total: string; lines: string[] } {
  if (snapshot === null || typeof snapshot !== "object") return { total: "—", lines: [] };
  const s = snapshot as Record<string, unknown>;
  const paise =
    typeof s.total_amount_paise === "number"
      ? s.total_amount_paise
      : typeof s.total_paise === "number"
        ? s.total_paise
        : null;
  const raw = Array.isArray(s.lines) ? s.lines : Array.isArray(s.items) ? s.items : [];
  return {
    total: paise === null ? "—" : formatPaise(paise),
    lines: raw.map((l) => {
      const o = l as Record<string, unknown>;
      const sku = typeof o.sku === "string" ? o.sku : typeof o.sku_id === "string" ? o.sku_id : "item";
      const qty = typeof o.qty === "number" ? o.qty : 1;
      return `${sku} ×${qty}`;
    }),
  };
}

export function ApprovalsScreen(): JSX.Element {
  const [tab, setTab] = useState<Tab>("PENDING");
  const qc = useQueryClient();

  const { data, error, isLoading } = useQuery({
    queryKey: ["admin", "approvals", tab],
    queryFn: () => fetchApprovals(tab),
    refetchInterval: 3_000,
  });

  const done = (): void => {
    void qc.invalidateQueries({ queryKey: ["admin", "approvals"] });
    void qc.invalidateQueries({ queryKey: ["admin", "analytics"] });
  };

  const approve = useMutation({
    mutationFn: (v: { id: string; note: string; version: number }) =>
      approveApproval(v.id, v.note, v.version),
    onSuccess: done,
  });
  const reject = useMutation({
    mutationFn: (v: { id: string; note: string }) => rejectApproval(v.id, v.note),
    onSuccess: done,
  });

  const acting = approve.isPending || reject.isPending;

  return (
    <Page
      title="Approvals"
      description="Carts the gatekeeper would not decide alone. Approving settles the exact proposal frozen at escalation time."
      actions={
        <Segmented
          options={TABS.map((t) => ({
            ...t,
            ...(t.value === tab ? { count: data?.length } : {}),
          }))}
          value={tab}
          onChange={setTab}
          label="Approval queue"
        />
      }
    >
      {error !== null && (
        <p className="rounded-lg border border-bad/40 bg-bad/5 px-4 py-3 text-[12px] text-bad-bright">
          Could not load the queue: {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {isLoading && <Empty>Loading…</Empty>}

      {data !== undefined && data.length === 0 && (
        <Empty>
          {tab === "PENDING"
            ? "Nothing is waiting on a human right now."
            : "No escalation has been decided yet."}
        </Empty>
      )}

      <div className="space-y-4">
        {(data ?? []).map((item) => (
          <ApprovalCard
            key={item.approval_id}
            item={item}
            pending={tab === "PENDING"}
            busy={acting}
            onApprove={(note) =>
              approve.mutate({ id: item.approval_id, note, version: item.rules_version })
            }
            onReject={(note) => reject.mutate({ id: item.approval_id, note })}
          />
        ))}
      </div>
    </Page>
  );
}

function ApprovalCard({
  item,
  pending,
  busy,
  onApprove,
  onReject,
}: {
  item: ApprovalRequest;
  pending: boolean;
  busy: boolean;
  onApprove: (note: string) => void;
  onReject: (note: string) => void;
}): JSX.Element {
  const [note, setNote] = useState("");
  const cart = cartOf(item.proposed_cart_snapshot);
  const left = ttl(item.expires_at);

  return (
    <article className="rounded-xl border border-edge bg-panel p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={pending ? "escalate" : "ok"} withDot={pending}>
            {item.reason.replace(/_/g, " ").toLowerCase()}
          </Chip>
          <Mono value={item.approval_id} truncate className="max-w-[200px]" />
          <span className="text-[11px] text-mute">policy v{item.rules_version}</span>
        </div>
        <div className="flex items-center gap-3">
          {pending && (
            <span className={`text-[11px] ${left.urgent ? "text-bad-bright" : "text-mute"}`}>
              {left.text}
            </span>
          )}
          <Link
            to={`/trace/${item.tx_id}`}
            className="text-[12px] text-ink-muted transition-colors hover:text-ink"
          >
            Trace →
          </Link>
        </div>
      </header>

      <p className="mt-4 max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        {item.band_context.observed}
      </p>

      <dl className="mt-5 flex flex-wrap gap-x-10 gap-y-3 border-t border-edge pt-4">
        <div>
          <dt className="text-[11px] text-mute">Frozen cart</dt>
          <dd className="mt-0.5 font-mono text-[13px] text-ink">{cart.total}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-mute">Against</dt>
          <dd className="mt-0.5 font-mono text-[13px] text-ink">{item.band_context.threshold}</dd>
        </div>
        {cart.lines.length > 0 && (
          <div className="min-w-0">
            <dt className="text-[11px] text-mute">Lines</dt>
            <dd className="mt-0.5 font-mono text-[13px] text-ink-muted">
              {cart.lines.join(" · ")}
            </dd>
          </div>
        )}
      </dl>

      {pending && (
        <div className="mt-5 flex flex-col gap-3 border-t border-edge pt-5 sm:flex-row sm:items-center">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the audit log (optional)"
            aria-label="Approver note"
            className={`${inputClass} flex-1`}
          />
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy} onClick={() => onApprove(note)}>
              {busy ? "Working…" : "Approve and settle"}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => onReject(note)}>
              Reject
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
