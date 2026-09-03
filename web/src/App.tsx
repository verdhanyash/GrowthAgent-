/**
 * App — the shell.
 *
 * Refined, pitch-black minimal fintech control plane.
 * Features a subtle translucent glassmorphic navigation bar,
 * live system connectivity indicator, and dedicated views for:
 *  - Analytics (Operations metrics)
 *  - Pipeline (Interactive connected-graph topology)
 *  - Transactions (Execution ledger)
 *  - Approvals (Human escalation inbox)
 *  - Policy (Gatekeeper rules management)
 *  - Simulate (Interactive attack and chaos harness)
 *  - Guide (How to use, architecture invariants & testing)
 */
import React from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Link, NavLink, Route, Routes, useParams } from "react-router-dom";
import { AgentKeyGate } from "./components/AgentKeyGate.js";
import { AnalyticsScreen } from "./screens/AnalyticsScreen.js";
import { PipelineScreen } from "./screens/PipelineScreen.js";
import { TransactionsScreen } from "./screens/TransactionsScreen.js";
import { ApprovalsScreen } from "./screens/ApprovalsScreen.js";
import { PolicyScreen } from "./screens/PolicyScreen.js";
import { SimulateScreen } from "./screens/SimulateScreen.js";
import { TraceScreen } from "./screens/TraceScreen.js";
import { GuideScreen } from "./screens/GuideScreen.js";
import { fetchApprovals } from "./lib/admin-api.js";

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

interface NavItem {
  to: string;
  label: string;
  badge?: number;
}

function Tab({ to, label, badge }: NavItem): JSX.Element {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-all ${
          isActive
            ? "bg-white/[0.08] text-white shadow-sm ring-1 ring-white/10"
            : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200"
        }`
      }
    >
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-escalate px-1 font-mono text-[9px] font-bold text-black">
          {badge}
        </span>
      )}
    </NavLink>
  );
}

function HeaderNav(): JSX.Element {
  // Query pending approvals count for the badge
  const { data: pendingList } = useQuery({
    queryKey: ["admin", "approvals", "pending_count"],
    queryFn: () => fetchApprovals("PENDING"),
    refetchInterval: 8_000,
  });

  const pendingCount = pendingList?.length ?? 0;

  const NAV_ITEMS: NavItem[] = [
    { to: "/", label: "Analytics" },
    { to: "/pipeline", label: "Pipeline" },
    { to: "/transactions", label: "Transactions" },
    { to: "/approvals", label: "Approvals", badge: pendingCount },
    { to: "/policy", label: "Policy" },
    { to: "/simulate", label: "Simulate" },
    { to: "/guide", label: "Guide" },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-black/75 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1320px] items-center justify-between px-6">
        {/* Left: Brand + Status Pill */}
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-90">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-white font-mono text-[11px] font-black text-black shadow-sm">
              G
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-white">
              GrowthAgent
            </span>
          </Link>

          <div className="hidden items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] text-neutral-400 sm:flex">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
            </span>
            <span className="font-mono text-[10px] tracking-wide">GATEKEEPER ACTIVE</span>
          </div>
        </div>

        {/* Center/Right: Navigation Tabs */}
        <nav aria-label="Main" className="flex items-center gap-1 overflow-x-auto py-1">
          {NAV_ITEMS.map((n) => (
            <Tab key={n.to} to={n.to} label={n.label} badge={n.badge} />
          ))}
        </nav>
      </div>
    </header>
  );
}

function Shell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-canvas font-sans text-ink">
      <HeaderNav />
      <main className="mx-auto w-full max-w-[1320px] flex-1 px-6 py-8">
        <AgentKeyGate>{children}</AgentKeyGate>
      </main>
    </div>
  );
}

function TraceRoute(): JSX.Element {
  const { txId } = useParams<{ txId: string }>();
  if (txId === undefined || txId === "") return <TransactionsScreen />;
  return <TraceScreen txId={txId} />;
}

export default function App(): JSX.Element {
  return (
    <QueryClientProvider client={qc}>
      <Shell>
        <Routes>
          <Route path="/" element={<AnalyticsScreen />} />
          <Route path="/pipeline" element={<PipelineScreen />} />
          <Route path="/transactions" element={<TransactionsScreen />} />
          <Route path="/approvals" element={<ApprovalsScreen />} />
          <Route path="/policy" element={<PolicyScreen />} />
          <Route path="/simulate" element={<SimulateScreen />} />
          <Route path="/guide" element={<GuideScreen />} />
          <Route path="/trace/:txId" element={<TraceRoute />} />
          <Route path="*" element={<AnalyticsScreen />} />
        </Routes>
      </Shell>
    </QueryClientProvider>
  );
}
