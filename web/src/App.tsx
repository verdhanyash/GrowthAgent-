/**
 * App — the buyer-surface shell. React Router gives deep-linkable traces
 * (/trace/:txId works on reload because the SSE replays the full audit log from
 * seq 0), TanStack Query drives the terminal poll, and AgentKeyGate blocks
 * everything until a runtime agent key is present (demo posture, config.ts).
 *
 * Scope (confirmed): buyer flow + read-only trace. No admin/rules/scenario
 * mutation screens — those endpoints don't exist yet (deferred to M10).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { AgentKeyGate } from "./components/AgentKeyGate.js";
import { ProposalComposer } from "./screens/BuyerView.js";
import { TraceScreen } from "./screens/TraceScreen.js";

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

function Shell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="min-h-screen">
      <header className="border-b border-edge bg-panel/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link to="/" className="text-[18px] font-bold tracking-tight text-ink">
            GrowthAgent <span className="text-accent">mission control</span>
          </Link>
          <span className="hidden text-[12px] text-mute sm:block">AI proposes. The gatekeeper disposes.</span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <AgentKeyGate>{children}</AgentKeyGate>
      </main>
    </div>
  );
}

function ComposerRoute(): JSX.Element {
  const nav = useNavigate();
  return <ProposalComposer onTx={(txId) => nav(`/trace/${txId}`)} />;
}

function TraceRoute(): JSX.Element {
  const { txId } = useParams<{ txId: string }>();
  const nav = useNavigate();
  if (!txId) {
    nav("/");
    return <></>;
  }
  return (
    <div className="space-y-4">
      <button type="button" onClick={() => nav("/")} className="text-[12px] text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        ← new proposal
      </button>
      <TraceScreen txId={txId} />
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <QueryClientProvider client={qc}>
      <Shell>
        <Routes>
          <Route path="/" element={<ComposerRoute />} />
          <Route path="/trace/:txId" element={<TraceRoute />} />
          <Route path="*" element={<ComposerRoute />} />
        </Routes>
      </Shell>
    </QueryClientProvider>
  );
}
