/**
 * web/src/screens/PipelineScreen.tsx
 *
 * Interactive End-to-End Pipeline Visualization.
 * Graph nodes represent real pipeline stages, agents, rules, settlements,
 * and system relationships powered entirely by actual database telemetry.
 */
import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { fetchAnalytics, fetchRules, fetchTransactions } from "../lib/admin-api.js";
import { PipelineGraph, type StageId } from "../components/PipelineGraph.js";
import { Pipeline3D } from "../components/Pipeline3D.js";
import { formatPaise, type TxListRow } from "@growthagent/shared";
import { Page, Section, StatTile } from "../components/ui.js";

export function PipelineScreen(): JSX.Element {
  const [selectedStage, setSelectedStage] = useState<StageId>("gatekeeper");
  const [selectedTxId, setSelectedTxId] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"graph" | "3d">("graph");

  // Fetch real platform analytics
  const { data: analytics } = useQuery({
    queryKey: ["admin", "analytics", "24h"],
    queryFn: () => fetchAnalytics("24h"),
    refetchInterval: 8_000,
  });

  // Fetch real active merchant rules
  const { data: rulesData } = useQuery({
    queryKey: ["admin", "rules"],
    queryFn: fetchRules,
  });

  // Fetch real recent transactions
  const { data: txListData } = useQuery({
    queryKey: ["admin", "transactions", "recent"],
    queryFn: () => fetchTransactions({ limit: 15 }),
    refetchInterval: 8_000,
  });

  const transactions = txListData?.transactions ?? [];
  const selectedTx: TxListRow | null =
    selectedTxId !== "all"
      ? transactions.find((t) => t.tx_id === selectedTxId) ?? null
      : null;

  const latencies = analytics?.stage_latency ?? [];
  const rules = rulesData?.rules;

  return (
    <Page
      title="System Pipeline Topology"
      description="Interactive, graph-based architecture trace powered by real runtime telemetry."
    >
      {/* Top Controls: Transaction Selector & View Mode */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-edge bg-panel p-4">
        <div className="flex items-center gap-3">
          <label htmlFor="tx-select" className="text-[12px] font-medium text-mute">
            Trace Context:
          </label>
          <select
            id="tx-select"
            value={selectedTxId}
            onChange={(e) => setSelectedTxId(e.target.value)}
            className="rounded-lg border border-edge bg-canvas px-3 py-1.5 font-mono text-[12px] text-ink focus:border-white/40 focus:outline-none"
          >
            <option value="all">All Traffic (Aggregated Live Telemetry)</option>
            {transactions.map((tx) => (
              <option key={tx.tx_id} value={tx.tx_id}>
                {tx.tx_id.slice(0, 18)}... · {tx.outcome} · {tx.agent_id}
              </option>
            ))}
          </select>
          {selectedTx && (
            <Link
              to={`/trace/${selectedTx.tx_id}`}
              className="rounded-md border border-edge px-2.5 py-1 text-[11px] text-ink-muted hover:border-white/30 hover:text-white"
            >
              Open Full Trace →
            </Link>
          )}
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-edge bg-canvas p-1">
          <button
            type="button"
            onClick={() => setViewMode("graph")}
            className={`rounded-md px-3 py-1 text-[12px] transition-colors ${
              viewMode === "graph"
                ? "bg-neutral-800 font-medium text-white"
                : "text-mute hover:text-ink"
            }`}
          >
            Interactive Flow
          </button>
          <button
            type="button"
            onClick={() => setViewMode("3d")}
            className={`rounded-md px-3 py-1 text-[12px] transition-colors ${
              viewMode === "3d"
                ? "bg-neutral-800 font-medium text-white"
                : "text-mute hover:text-ink"
            }`}
          >
            Isometric 3D
          </button>
        </div>
      </div>

      {/* Real Live Metrics Strip */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile
          label="Total Pipeline Ingress"
          value={String(analytics?.totals.proposals ?? 0)}
          meta={`${analytics?.totals.in_flight ?? 0} in-flight runs`}
        />
        <StatTile
          label="Decision Latency (P50)"
          value={`${analytics?.totals.decision_p50_ms ?? 0}ms`}
          meta={`P95: ${analytics?.totals.decision_p95_ms ?? 0}ms`}
        />
        <StatTile
          label="Adversarial Blocked"
          value={String(analytics?.totals.injections_blocked ?? 0)}
          meta="Prompt injections caught"
        />
        <StatTile
          label="Settled Value"
          value={formatPaise(analytics?.totals.settled_value_paise ?? 0)}
          meta={`${analytics?.totals.approved ?? 0} approved orders`}
        />
      </div>

      {/* Main Canvas + Stage Inspector Layout */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left 2 Cols: The Graph Canvas */}
        <div className="lg:col-span-2">
          {viewMode === "graph" ? (
            <PipelineGraph
              analytics={analytics}
              rules={rules}
              selectedTx={selectedTx}
              selectedStage={selectedStage}
              onSelectStage={setSelectedStage}
            />
          ) : (
            <Pipeline3D
              analytics={analytics}
              selectedTx={selectedTx}
              selectedStage={selectedStage}
              onSelectStage={setSelectedStage}
            />
          )}
        </div>

        {/* Right Col: Deep Stage Inspector */}
        <div className="rounded-xl border border-edge bg-panel p-5">
          <StageInspector
            stageId={selectedStage}
            analytics={analytics}
            rules={rules}
            selectedTx={selectedTx}
          />
        </div>
      </div>
    </Page>
  );
}

/**
 * Deep Inspector Panel showing real invariants and live parameters for the selected stage.
 */
function StageInspector({
  stageId,
  analytics,
  rules,
  selectedTx,
}: {
  stageId: StageId;
  analytics?: ReturnType<typeof fetchAnalytics> extends Promise<infer T> ? T : never;
  rules?: ReturnType<typeof fetchRules> extends Promise<{ rules: infer R }> ? R : never;
  selectedTx: TxListRow | null;
}): JSX.Element {
  const stageTelemetry = analytics?.stage_latency?.find((s) => {
    if (stageId === "intake") return s.stage === "INTAKE";
    if (stageId === "context") return s.stage === "CONTEXT_BUILD";
    if (stageId === "negotiation") return s.stage === "NEGOTIATION";
    if (stageId === "citation") return s.stage === "CITATION_AUDIT";
    if (stageId === "gatekeeper") return s.stage === "GATEKEEPER";
    if (stageId === "settlement") return s.stage === "SETTLEMENT";
    return false;
  });

  const titles: Record<StageId, { name: string; type: string; desc: string }> = {
    buyer: {
      name: "Buyer Agent Ingress",
      type: "UNTRUSTED INGRESS (POST /v1/carts/proposals)",
      desc: "External AI agents submit purchase proposals. Client identity is verified via SHA-256 API key hashing, and double-submissions are blocked by the atomic proposal_idempotency ledger.",
    },
    intake: {
      name: "Stage 1: Intake & Injection Guard",
      type: "DETERMINISTIC HEURISTIC SCANNER",
      desc: "Scans raw buyer notes for prompt injection triggers (override codes, system note spoofing, unicode evasion) before any LLM sees the text.",
    },
    context: {
      name: "Stage 2: Context & Ground Truth",
      type: "AUTHORITATIVE POSTGRESQL DATASTORE",
      desc: "Builds an isolated Evidence Pack (E001–E999) from raw catalog items, live inventory stock, and seeded sales trends. The LLM is restricted to citing ONLY items in this pack.",
    },
    negotiation: {
      name: "Stage 3: AI Negotiator Agent",
      type: "NVIDIA NIM (META/LLAMA-3.3-70B-INSTRUCT)",
      desc: "Generative LLM proposal engine. Formats conversational intent into a candidate cart with JSON grammar constraints. It is strictly forbidden from commanding money or prices.",
    },
    citation: {
      name: "Stage 4: Citation Auditor",
      type: "DETERMINISTIC CLAIMS AUDITOR",
      desc: "Verifies every product SKU, list price, and promotional claim against the Evidence Pack. Any hallucinated price or discount is immediately stripped.",
    },
    gatekeeper: {
      name: "Stage 5: Deterministic Gatekeeper",
      type: "PURE MATHEMATICAL CHECKPOINT (ZERO I/O)",
      desc: "THE FINANCIAL AUTHORITY. Completely recalculates all gross totals, discounts, and margins from raw ground-truth catalog records using strict integer paise arithmetic (no floats). Enforces 16 immutable merchant rules.",
    },
    approvals: {
      name: "Approvals Inbox (Human-in-the-Loop)",
      type: "HMAC CAPABILITY TOKEN WORKBENCH",
      desc: "When a proposal triggers GK-INJECTION-GUARD or GK-HIGH-VALUE-ESCALATE, it halts in AWAITING_HUMAN_APPROVAL. A single-use HMAC capability token is generated for the merchant.",
    },
    settlement: {
      name: "Stage 6: Settlement Rail",
      type: "POSTGRESQL CAS + RAZORPAY ORDERS API",
      desc: "Acquires sorted, deadlock-free stock reservations (Model A), creates Razorpay Orders, and captures payments only upon receiving HMAC-verified webhooks.",
    },
    audit: {
      name: "Stage 7: Tamper-Evident Audit Chain",
      type: "CRYPTOGRAPHIC SHA-256 HASH CHAIN & SSE",
      desc: "Every stage appends to the immutable audit_log table. Each record hashes the payload and links to prev_hash, streamed live to clients via Server-Sent Events (SSE).",
    },
  };

  const meta = titles[stageId];

  return (
    <div className="space-y-5">
      <div>
        <span className="rounded bg-white/[0.08] px-2 py-0.5 font-mono text-[10px] tracking-wider text-mute">
          {meta.type}
        </span>
        <h3 className="mt-2 text-[16px] font-semibold text-white">{meta.name}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{meta.desc}</p>
      </div>

      {/* Selected Transaction Status (if any) */}
      {selectedTx && (
        <div className="rounded-lg border border-edge bg-canvas p-3">
          <p className="text-[11px] font-medium text-mute">Focused Transaction</p>
          <div className="mt-1 flex items-center justify-between text-[12px]">
            <span className="font-mono text-ink">{selectedTx.tx_id.slice(0, 16)}...</span>
            <span
              className={`font-mono text-[11px] font-semibold ${
                selectedTx.outcome === "APPROVED"
                  ? "text-ok-bright"
                  : selectedTx.outcome === "ESCALATED"
                  ? "text-escalate-bright"
                  : "text-bad-bright"
              }`}
            >
              {selectedTx.outcome}
            </span>
          </div>
          {selectedTx.value_paise !== null && (
            <p className="mt-1 font-mono text-[12px] text-ink-muted">
              Value: {formatPaise(selectedTx.value_paise)}
            </p>
          )}
        </div>
      )}

      {/* Live Stage Latency from Database */}
      <div className="space-y-2 border-t border-edge pt-4">
        <h4 className="text-[12px] font-medium uppercase tracking-wider text-mute">
          Live Runtime Telemetry
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-edge bg-canvas p-2.5">
            <span className="text-[10px] text-mute">P50 Latency</span>
            <p className="font-mono text-[14px] font-semibold text-ink">
              {stageTelemetry?.p50_ms !== undefined ? `${stageTelemetry.p50_ms}ms` : "—"}
            </p>
          </div>
          <div className="rounded-lg border border-edge bg-canvas p-2.5">
            <span className="text-[10px] text-mute">P95 Latency</span>
            <p className="font-mono text-[14px] font-semibold text-ink">
              {stageTelemetry?.p95_ms !== undefined ? `${stageTelemetry.p95_ms}ms` : "—"}
            </p>
          </div>
        </div>
      </div>

      {/* Stage-Specific Live Configurations & Findings */}
      {stageId === "gatekeeper" && rules && (
        <div className="space-y-2 border-t border-edge pt-4">
          <h4 className="text-[12px] font-medium uppercase tracking-wider text-mute">
            Active Gatekeeper Invariants
          </h4>
          <div className="space-y-1.5 text-[11px] text-ink-muted">
            <div className="flex justify-between border-b border-edge/40 pb-1">
              <span>Max Aggregate Discount</span>
              <span className="font-mono text-ink">{rules.max_discount_pct}%</span>
            </div>
            <div className="flex justify-between border-b border-edge/40 pb-1">
              <span>Gross Margin Floor</span>
              <span className="font-mono text-ink">{rules.margin_floor_pct}%</span>
            </div>
            <div className="flex justify-between border-b border-edge/40 pb-1">
              <span>Cart Net Minimum</span>
              <span className="font-mono text-ink">{formatPaise(10_000)} (₹100 Floor)</span>
            </div>
            <div className="flex justify-between border-b border-edge/40 pb-1">
              <span>Auto-Approve Cart Ceiling</span>
              <span className="font-mono text-ink">{formatPaise(rules.max_cart_value_paise)}</span>
            </div>
          </div>
        </div>
      )}

      {stageId === "intake" && (
        <div className="space-y-2 border-t border-edge pt-4">
          <h4 className="text-[12px] font-medium uppercase tracking-wider text-mute">
            Active Injection Signatures
          </h4>
          <ul className="space-y-1 text-[11px] text-ink-muted">
            <li className="flex items-center gap-1.5 font-mono">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
              SYSTEM_NOTE_SPOOF (admin/system override tokens)
            </li>
            <li className="flex items-center gap-1.5 font-mono">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
              DISCOUNT_OVERRIDE (forced 80-100% tags)
            </li>
            <li className="flex items-center gap-1.5 font-mono">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
              UNICODE_OBFUSCATION (invisible joiners)
            </li>
          </ul>
        </div>
      )}

      {stageId === "settlement" && (
        <div className="space-y-2 border-t border-edge pt-4">
          <h4 className="text-[12px] font-medium uppercase tracking-wider text-mute">
            Settlement State Machine
          </h4>
          <div className="rounded-lg border border-edge bg-canvas p-2.5 font-mono text-[11px] text-mute">
            INTENT → ORDER_CREATED → AWAITING_PAYMENT → PAID → COMPLETED
          </div>
        </div>
      )}
    </div>
  );
}
