/**
 * App — the shell.
 *
 * Five destinations, because the app does five things: look at what happened
 * (Analytics), find one run (Transactions), decide the ones a human must decide
 * (Approvals), change what the gatekeeper enforces (Policy), and generate
 * traffic (Simulate). The trace view is a detail of Transactions, not a
 * destination of its own.
 *
 * What used to be here and is gone: a seven-item nav where three items were
 * documentation or duplicated launchers, a ⌘K palette for navigating seven
 * items, and a footer tagline. Navigation should be too small to need a search
 * box over it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, NavLink, Route, Routes, useParams } from "react-router-dom";
import { AgentKeyGate } from "./components/AgentKeyGate.js";
import { AnalyticsScreen } from "./screens/AnalyticsScreen.js";
import { TransactionsScreen } from "./screens/TransactionsScreen.js";
import { ApprovalsScreen } from "./screens/ApprovalsScreen.js";
import { PolicyScreen } from "./screens/PolicyScreen.js";
import { SimulateScreen } from "./screens/SimulateScreen.js";
import { TraceScreen } from "./screens/TraceScreen.js";

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const NAV = [
  { to: "/", label: "Analytics" },
  { to: "/transactions", label: "Transactions" },
  { to: "/approvals", label: "Approvals" },
  { to: "/policy", label: "Policy" },
  { to: "/simulate", label: "Simulate" },
] as const;

function Tab({ to, label }: { to: string; label: string }): JSX.Element {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `rounded-md px-3 py-1.5 text-[13px] transition-colors ${
          isActive ? "bg-neutral-800 text-ink" : "text-mute hover:text-ink"
        }`
      }
    >
      {label}
    </NavLink>
  );
}

function Shell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-canvas font-sans text-ink">
      <header className="sticky top-0 z-30 border-b border-edge bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-8 gap-y-2 px-6 py-3">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-ink font-mono text-[10px] font-bold text-black">
              G
            </span>
            <span className="text-[14px] font-semibold tracking-tight">GrowthAgent</span>
          </Link>
          {/* min-w-0 is load-bearing: without it this flex item keeps its
              intrinsic width, overflows the header at phone widths and drags the
              whole document wider than the viewport. */}
          <nav aria-label="Main" className="flex min-w-0 flex-wrap items-center gap-0.5">
            {NAV.map((n) => (
              <Tab key={n.to} to={n.to} label={n.label} />
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-6 py-10">
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
          <Route path="/transactions" element={<TransactionsScreen />} />
          <Route path="/approvals" element={<ApprovalsScreen />} />
          <Route path="/policy" element={<PolicyScreen />} />
          <Route path="/simulate" element={<SimulateScreen />} />
          <Route path="/trace/:txId" element={<TraceRoute />} />
          <Route path="*" element={<AnalyticsScreen />} />
        </Routes>
      </Shell>
    </QueryClientProvider>
  );
}
