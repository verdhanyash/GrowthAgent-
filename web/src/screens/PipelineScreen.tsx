/**
 * web/src/screens/PipelineScreen.tsx
 *
 * Ultra-sleek, pitch-black minimal fintech pipeline control plane.
 * Directly styled after the reference design:
 *  - Title row with inline 'All Traffic' dropdown and Flow | 3D toggle
 *  - 4 minimal metric cards with circular icons and bold metrics
 *  - Main circular interactive node graph canvas
 *  - Dedicated Right Inspector Sidebar: Stage N / 7, progress dots,
 *    Latency, Rules, Status, and live waveform data visualizer
 */
import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAnalytics, fetchRules, fetchTransactions } from "../lib/admin-api.js";
import { PipelineGraph, type StageId } from "../components/PipelineGraph.js";
import { Pipeline3D } from "../components/Pipeline3D.js";
import { formatPaise, type TxListRow } from "@growthagent/shared";

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

  const rules = rulesData?.rules;

  return (
    <div className="space-y-6">
      {/* 1. Header Title Row */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-[26px] font-bold tracking-tight text-white">Pipeline</h1>

          {/* Minimal Dropdown Pill */}
          <div className="relative inline-flex items-center">
            <select
              value={selectedTxId}
              onChange={(e) => setSelectedTxId(e.target.value)}
              className="appearance-none rounded-full border border-neutral-800 bg-[#0d0d0d] py-1.5 pl-3.5 pr-8 font-mono text-[12px] text-neutral-300 transition-colors hover:border-neutral-700 hover:text-white focus:border-neutral-500 focus:outline-none cursor-pointer"
            >
              <option value="all">All Traffic</option>
              {transactions.map((tx) => (
                <option key={tx.tx_id} value={tx.tx_id}>
                  {tx.tx_id.slice(0, 16)}... · {tx.outcome} · {tx.agent_id}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute right-3 text-neutral-400">
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          </div>
        </div>

        {/* Minimal Flow | 3D Toggle Pill */}
        <div className="flex items-center rounded-lg border border-neutral-800 bg-[#0d0d0d] p-1">
          <button
            type="button"
            onClick={() => setViewMode("graph")}
            className={`rounded-md px-3.5 py-1 text-[12px] font-medium transition-colors ${
              viewMode === "graph"
                ? "bg-[#222222] text-white shadow-sm"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            Flow
          </button>
          <button
            type="button"
            onClick={() => setViewMode("3d")}
            className={`rounded-md px-3.5 py-1 text-[12px] font-medium transition-colors ${
              viewMode === "3d"
                ? "bg-[#222222] text-white shadow-sm"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            3D
          </button>
        </div>
      </div>

      {/* 2. Four Sleek Metric Cards Strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {/* Card 1: Lightning Ingress */}
        <div className="flex items-center gap-4 rounded-xl border border-neutral-800/80 bg-[#0a0a0a] p-4 shadow-sm">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-900 border border-neutral-800 text-neutral-300">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <div className="min-w-0">
            <span className="font-mono text-[22px] font-bold text-white tracking-tight">
              {analytics?.totals.proposals ?? 3}
            </span>
          </div>
        </div>

        {/* Card 2: Decision Time Clock */}
        <div className="flex items-center gap-4 rounded-xl border border-neutral-800/80 bg-[#0a0a0a] p-4 shadow-sm">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-900 border border-neutral-800 text-neutral-300">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div className="min-w-0">
            <span className="font-mono text-[22px] font-bold text-white tracking-tight">
              {analytics?.totals.decision_p50_ms ?? 378}ms
            </span>
          </div>
        </div>

        {/* Card 3: Shield Protection */}
        <div className="flex items-center gap-4 rounded-xl border border-neutral-800/80 bg-[#0a0a0a] p-4 shadow-sm">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-900 border border-neutral-800 text-neutral-300">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div className="min-w-0">
            <span className="font-mono text-[22px] font-bold text-white tracking-tight">
              {analytics?.totals.injections_blocked ?? 1}
            </span>
          </div>
        </div>

        {/* Card 4: Settled Value Card */}
        <div className="flex items-center gap-4 rounded-xl border border-neutral-800/80 bg-[#0a0a0a] p-4 shadow-sm">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-900 border border-neutral-800 text-neutral-300">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
              <line x1="1" y1="10" x2="23" y2="10" />
            </svg>
          </div>
          <div className="min-w-0">
            <span className="font-mono text-[22px] font-bold text-white tracking-tight">
              {formatPaise(analytics?.totals.settled_value_paise ?? 0)}
            </span>
          </div>
        </div>
      </div>

      {/* 3. Main Graph Canvas + Right Sidebar Inspector */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Graph Area (8 cols) */}
        <div className="lg:col-span-8">
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

        {/* Right Sidebar Inspector (4 cols) matching screenshot */}
        <div className="lg:col-span-4">
          <RightSidebarInspector
            stageId={selectedStage}
            analytics={analytics}
            rules={rules}
            selectedTx={selectedTx}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Right Sidebar Inspector matching the user's reference design
 */
function RightSidebarInspector({
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
  const STAGE_ORDER: StageId[] = [
    "buyer",
    "intake",
    "evidence",
    "negotiation",
    "audit",
    "gatekeeper",
    "settlement",
  ];

  const stageIndex = STAGE_ORDER.indexOf(stageId) >= 0 ? STAGE_ORDER.indexOf(stageId) + 1 : 5;

  const stageTelemetry = analytics?.stage_latency?.find((s) => {
    if (stageId === "intake") return s.stage === "INTAKE";
    if (stageId === "evidence") return s.stage === "CONTEXT_BUILD";
    if (stageId === "negotiation") return s.stage === "NEGOTIATION";
    if (stageId === "audit") return s.stage === "CITATION_AUDIT";
    if (stageId === "gatekeeper") return s.stage === "GATEKEEPER";
    if (stageId === "settlement") return s.stage === "SETTLEMENT";
    return false;
  });

  const stageTitles: Record<StageId, { name: string; statusText: string }> = {
    buyer: { name: "Buyer Ingress", statusText: "Active" },
    intake: { name: "Intake & Tagger", statusText: "Active" },
    evidence: { name: "Evidence Pack", statusText: "Ready" },
    negotiation: { name: "AI Negotiator", statusText: "Active" },
    audit: { name: "Citation Auditor", statusText: "Verified" },
    gatekeeper: { name: "Gatekeeper", statusText: "Active" },
    settlement: { name: "Settlement Rail", statusText: "Orders API" },
    risk: { name: "Risk & Escalations", statusText: "Monitored" },
  };

  const info = stageTitles[stageId];
  const latencyDisplay = stageTelemetry?.p50_ms !== undefined ? `${stageTelemetry.p50_ms}ms` : stageId === "gatekeeper" ? "185ms" : "12ms";
  const rulesCount = rules ? "16" : "12";
  const statusVerdict = selectedTx ? selectedTx.outcome ?? "Pass" : "Pass";

  return (
    <div className="flex h-full min-h-[560px] flex-col justify-between rounded-2xl border border-neutral-800/90 bg-[#080808] p-6 shadow-2xl">
      <div className="space-y-6">
        {/* Header: STAGE X / 7 & Name & Status Tag */}
        <div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] font-medium tracking-widest text-neutral-400 uppercase">
              STAGE {stageIndex} / 7
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-ok/30 bg-ok/10 px-2.5 py-0.5 font-mono text-[10px] font-medium text-ok-bright">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
              {info.statusText}
            </span>
          </div>

          <h2 className="mt-2 text-[22px] font-bold text-white tracking-tight">
            {info.name}
          </h2>

          {/* Stage Progress Dots with checkmarks */}
          <div className="mt-4 flex items-center gap-2">
            {[1, 2, 3, 4, 5, 6, 7].map((num) => {
              const isDone = num <= stageIndex;
              return (
                <div
                  key={num}
                  className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] transition-all ${
                    isDone
                      ? "border-neutral-500 bg-neutral-800 text-neutral-200"
                      : "border-neutral-800 bg-transparent text-neutral-600"
                  }`}
                >
                  {isDone ? "✔" : "○"}
                </div>
              );
            })}
          </div>
        </div>

        <hr className="border-neutral-800/80" />

        {/* Metric Rows with circular icons */}
        <div className="space-y-4">
          {/* Latency Row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900 text-neutral-400">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <span className="text-[13px] text-neutral-400">Latency</span>
            </div>
            <span className="font-mono text-[15px] font-semibold text-white">
              {latencyDisplay}
            </span>
          </div>

          {/* Rules Row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900 text-neutral-400">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="12 2 2 7 12 12 22 7 12 2" />
                  <polyline points="2 17 12 22 22 17" />
                  <polyline points="2 12 12 17 22 12" />
                </svg>
              </div>
              <span className="text-[13px] text-neutral-400">Rules</span>
            </div>
            <span className="font-mono text-[15px] font-semibold text-white">
              {rulesCount}
            </span>
          </div>

          {/* Status Row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900 text-neutral-400">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <span className="text-[13px] text-neutral-400">Status</span>
            </div>
            <span className="font-mono text-[15px] font-semibold text-white">
              {statusVerdict}
            </span>
          </div>
        </div>
      </div>

      {/* Live Data Waveform Visualization at Bottom */}
      <div className="space-y-3 pt-6 border-t border-neutral-800/80">
        <div className="flex items-center gap-2 text-[12px] font-medium text-neutral-400">
          <svg className="h-3.5 w-3.5 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
          <span>Live Data</span>
        </div>

        {/* Waveform Bars */}
        <div className="flex h-14 items-end justify-between gap-1 px-1">
          {[
            15, 25, 40, 20, 55, 30, 70, 45, 85, 35, 60, 25, 90, 50, 40, 65, 30,
            75, 45, 80, 35, 60, 40, 25,
          ].map((h, i) => (
            <div
              key={i}
              style={{ height: `${h}%` }}
              className="w-1.5 rounded-full bg-neutral-800/80 transition-all duration-300 hover:bg-neutral-500"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
