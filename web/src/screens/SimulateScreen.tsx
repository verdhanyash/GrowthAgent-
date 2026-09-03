/**
 * web/src/screens/SimulateScreen.tsx — the one place that puts traffic through
 * the pipeline.
 *
 * This screen replaces two: the buyer composer and the demo console. They had
 * three of the same scenarios each (well-behaved / injection / high-value), so
 * a reader had to know that "preset" and "beat" meant the same thing on
 * different screens. The server-side scenarios win because they self-grade —
 * they assert the outcome rather than asking you to eyeball it — and the custom
 * composer stays for anything the scripted five do not cover.
 *
 * Chaos and reset are real controls, but they are used once a session, so they
 * sit behind a disclosure instead of occupying a third of the screen.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import type { ScenarioName, ScenarioRunResult } from "@growthagent/shared";
import type { CreateProposalRequest } from "@growthagent/shared";
import { ApiError, createProposal } from "../lib/api.js";
import {
  armChaos,
  disarmChaos,
  fetchChaos,
  fetchScenarioRun,
  resetDemo,
  runScenario,
} from "../lib/admin-api.js";
import {
  Button,
  Chip,
  Field,
  Mono,
  Page,
  Section,
  inputClass,
} from "../components/ui.js";

interface Scenario {
  id: ScenarioName;
  name: string;
  expected: string;
  what: string;
}

/** The five scripted runs, each with the outcome its assertions demand. */
const SCENARIOS: readonly Scenario[] = [
  {
    id: "well_behaved",
    name: "Ordinary buyer",
    expected: "Approved",
    what: "A polite gift-basket request that satisfies every invariant and settles.",
  },
  {
    id: "adversarial_injection",
    name: "Prompt injection",
    expected: "Declined",
    what: "A customer note claiming a discount override. Flagged at intake, refused on rule ground truth.",
  },
  {
    id: "high_value_escalate",
    name: "High-value cart",
    expected: "Escalated",
    what: "A cart engineered onto the soft band, so the gatekeeper hands it to a human.",
  },
  {
    id: "llm_timeout_chaos",
    name: "LLM timeout",
    expected: "Approved via fallback",
    what: "The model is made to time out; the deterministic bundle takes over without leaking money.",
  },
  {
    id: "gateway_error_chaos",
    name: "Gateway outage",
    expected: "Failed honestly",
    what: "Razorpay returns 503. Retries, then an honest failure rather than a fake decline.",
  },
];

const idem = (prefix: string): string =>
  `${prefix}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;

export function SimulateScreen(): JSX.Element {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [runId, setRunId] = useState<string | null>(null);
  const [nl, setNl] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const { data: run } = useQuery<ScenarioRunResult>({
    queryKey: ["admin", "scenario-run", runId],
    queryFn: () => fetchScenarioRun(runId as string),
    enabled: runId !== null,
    refetchInterval: (q) =>
      q.state.data?.status === "DONE" || q.state.data?.status === "ERROR" ? false : 500,
  });

  const { data: chaos } = useQuery({ queryKey: ["admin", "chaos"], queryFn: fetchChaos });

  const launch = useMutation({
    mutationFn: (name: ScenarioName) => runScenario(name),
    onSuccess: (d) => {
      setRunId(d.run_id);
      setErr(null);
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const propose = useMutation({
    mutationFn: (body: CreateProposalRequest) => createProposal(body),
    onSuccess: (accepted) => nav(`/trace/${accepted.tx_id}`),
    onError: (e: unknown) =>
      setErr(
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : "Request failed",
      ),
  });

  const invalidateChaos = (): void => {
    void qc.invalidateQueries({ queryKey: ["admin", "chaos"] });
  };
  const arm = useMutation({
    mutationFn: (flag: "LLM_TIMEOUT" | "GATEWAY_ERROR") => armChaos(flag),
    onSuccess: invalidateChaos,
  });
  const disarm = useMutation({ mutationFn: disarmChaos, onSuccess: invalidateChaos });
  const reset = useMutation({
    mutationFn: () => resetDemo(true),
    onSuccess: (d) => {
      setResetMsg(`Reset to pristine fixtures at ${new Date(d.reset_at).toLocaleTimeString()}`);
      void qc.invalidateQueries();
    },
    onError: (e: unknown) =>
      setResetMsg(`Reset failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  const submitCustom = (): void => {
    if (nl.trim() === "") {
      setErr("Describe what the buyer wants first.");
      return;
    }
    setErr(null);
    propose.mutate({
      customer_request: { natural_language: nl.trim() },
      untrusted: { customer_note: note },
      idempotency_key: idem("custom"),
    });
  };

  return (
    <Page
      title="Simulate"
      description="Put a buyer request through the real pipeline — a scripted scenario that grades itself, or your own wording."
    >
      {err !== null && (
        <p className="rounded-lg border border-bad/40 bg-bad/5 px-4 py-3 text-[12px] text-bad-bright">
          {err}
        </p>
      )}

      <Section
        title="Scripted scenarios"
        hint="Each one asserts its own outcome, so a pass is evidence rather than an impression."
      >
        <ul className="divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-panel">
          {SCENARIOS.map((s) => {
            const busy = launch.isPending && launch.variables === s.id;
            return (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-4 px-6 py-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] text-ink">{s.name}</span>
                    <Chip>{s.expected}</Chip>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-mute">{s.what}</p>
                </div>
                <Button
                  disabled={launch.isPending}
                  onClick={() => launch.mutate(s.id)}
                >
                  {busy ? "Running…" : "Run"}
                </Button>
              </li>
            );
          })}
        </ul>

        {run !== undefined && <RunVerdict run={run} />}
      </Section>

      <Section
        title="Custom request"
        hint="Anything the five above do not cover. The note is untrusted input and is scanned for injection."
      >
        <div className="space-y-5 rounded-xl border border-edge bg-panel p-6">
          <Field label="What does the buyer want?">
            <textarea
              value={nl}
              onChange={(e) => setNl(e.target.value)}
              rows={3}
              placeholder="A Diwali hamper with cookies and a chocolate cake, under ₹2,500"
              className={inputClass}
            />
          </Field>
          <Field label="Customer note" hint="optional · untrusted">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Anything the customer typed themselves"
              className={inputClass}
            />
          </Field>
          <Button variant="primary" disabled={propose.isPending} onClick={submitCustom}>
            {propose.isPending ? "Proposing…" : "Propose cart and open trace"}
          </Button>
        </div>
      </Section>

      <Section>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          className="text-[12px] text-mute transition-colors hover:text-ink"
        >
          {showAdvanced ? "Hide" : "Show"} fault injection and reset
        </button>

        {showAdvanced && (
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <div className="space-y-4 rounded-xl border border-edge bg-panel p-6">
              <div>
                <h3 className="text-[13px] font-semibold text-ink">Fault injection</h3>
                <p className="mt-0.5 text-[11px] text-mute">
                  Armed for ten minutes, then it disarms itself.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => arm.mutate("LLM_TIMEOUT")}>LLM timeout</Button>
                <Button onClick={() => arm.mutate("GATEWAY_ERROR")}>Gateway 503</Button>
                {(chaos?.length ?? 0) > 0 && (
                  <Button variant="danger" onClick={() => disarm.mutate()}>
                    Disarm all
                  </Button>
                )}
              </div>
              {(chaos?.length ?? 0) > 0 && (
                <ul className="space-y-1 border-t border-edge pt-3">
                  {chaos?.map((c) => (
                    <li key={c.flag} className="flex justify-between text-[11px]">
                      <span className="text-warn-bright">{c.flag}</span>
                      <span className="text-mute">
                        until {new Date(c.expires_at).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-4 rounded-xl border border-edge bg-panel p-6">
              <div>
                <h3 className="text-[13px] font-semibold text-ink">Reset</h3>
                <p className="mt-0.5 text-[11px] leading-relaxed text-mute">
                  Re-seeds catalogue stock, agent keys and the default policy, and releases every
                  open hold. In-flight transactions are force-expired.
                </p>
              </div>
              <Button variant="danger" disabled={reset.isPending} onClick={() => reset.mutate()}>
                {reset.isPending ? "Resetting…" : "Reset to pristine fixtures"}
              </Button>
              {resetMsg !== null && <p className="text-[11px] text-mute">{resetMsg}</p>}
            </div>
          </div>
        )}
      </Section>
    </Page>
  );
}

/**
 * The self-grading result. Expected vs actual side by side, then one line per
 * assertion — the assertions ARE the proof, so they are the body of the panel
 * rather than a detail behind a toggle.
 */
function RunVerdict({ run }: { run: ScenarioRunResult }): JSX.Element {
  const running = run.status === "RUNNING";
  const tone = running ? "border-edge" : run.pass ? "border-ok/40" : "border-bad/40";

  return (
    <div className={`space-y-4 rounded-xl border bg-panel p-6 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ink">{run.scenario}</span>
          {running ? (
            <Chip tone="run" withDot>
              running
            </Chip>
          ) : (
            <Chip tone={run.pass ? "ok" : "bad"}>
              {run.pass ? "all assertions passed" : "assertions failed"}
            </Chip>
          )}
        </div>
        {run.tx_ids[0] !== undefined && (
          <Link
            to={`/trace/${run.tx_ids[0]}`}
            className="text-[12px] text-ink-muted transition-colors hover:text-ink"
          >
            Open trace →
          </Link>
        )}
      </div>

      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-[11px] text-mute">Expected</dt>
          <dd className="mt-0.5 font-mono text-[12px] text-ink">{run.expected_outcome}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-mute">Actual</dt>
          <dd className="mt-0.5 font-mono text-[12px] text-ink">
            {run.actual_outcome ?? "waiting for a terminal state…"}
          </dd>
        </div>
      </dl>

      {run.assertions.length > 0 && (
        <ul className="divide-y divide-edge/60 border-t border-edge pt-1">
          {run.assertions.map((a, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
              <span className={a.pass ? "text-ok-bright" : "text-bad-bright"} aria-hidden>
                {a.pass ? "✓" : "✕"}
              </span>
              <span className="text-[12px] text-ink">{a.name}</span>
              <span className="text-[11px] text-mute">{a.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {run.tx_ids.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-edge pt-3">
          <span className="text-[11px] text-mute">Other transactions:</span>
          {run.tx_ids.slice(1).map((id) => (
            <Mono key={id} value={id} truncate className="max-w-[150px]" />
          ))}
        </div>
      )}
    </div>
  );
}
