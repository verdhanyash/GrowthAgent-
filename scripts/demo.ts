/**
 * scripts/demo.ts — Live CLI Demo Scenario Runner for Judges & Presenters (§12).
 *
 * Usage:
 *   npx tsx scripts/demo.ts all
 *   npx tsx scripts/demo.ts well_behaved
 *   npx tsx scripts/demo.ts adversarial_injection
 *   npx tsx scripts/demo.ts high_value_escalate
 *   npx tsx scripts/demo.ts llm_timeout_chaos
 *   npx tsx scripts/demo.ts gateway_error_chaos
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- demo driver reads loosely-typed JSON from the live API */
import {
  type ScenarioName,
  type ScenarioRunResult,
} from "../shared/src/api/admin-contracts.js";

const PORT = Number(process.env.API_PORT ?? 3000);
const API_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "ga-admin-token-test";

const SCENARIOS: { name: ScenarioName; title: string; beat: string }[] = [
  { name: "well_behaved", title: "Well-Behaved Happy Path", beat: "Beat 1" },
  { name: "adversarial_injection", title: "Adversarial Prompt Injection Caught", beat: "Beat 2" },
  { name: "high_value_escalate", title: "High-Value Cart Escalation", beat: "Beat 3" },
  { name: "llm_timeout_chaos", title: "LLM Timeout Fault Degradation", beat: "Chaos A" },
  { name: "gateway_error_chaos", title: "Payment Gateway 503 Outage Handling", beat: "Chaos B" },
];

async function runSingleScenario(scenario: ScenarioName, title: string, beat: string): Promise<boolean> {
  console.log(`\n\x1b[1;36m======================================================================\x1b[0m`);
  console.log(`\x1b[1;33m[${beat}]\x1b[0m \x1b[1;37m${title}\x1b[0m (\x1b[36m${scenario}\x1b[0m)`);
  console.log(`\x1b[1;36m======================================================================\x1b[0m`);

  try {
    const postRes = await fetch(`${API_URL}/v1/demo/scenarios/${scenario}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN_TOKEN,
      },
      body: JSON.stringify({}),
    });

    if (!postRes.ok) {
      const err = await postRes.text();
      console.error(`\x1b[1;31m✖ Failed to trigger scenario (HTTP ${postRes.status}):\x1b[0m ${err}`);
      return false;
    }

    const accepted = (await postRes.json()) as { run_id: string; tx_ids: string[]; watch_urls: string[] };
    const runId = accepted.run_id;
    const txId = accepted.tx_ids[0] ?? "";

    console.log(`  \x1b[32m✔ Launched run:\x1b[0m \x1b[1m${runId}\x1b[0m | Tx: \x1b[36m${txId}\x1b[0m`);
    console.log(`  \x1b[35m► Live SSE stream:\x1b[0m ${API_URL}${accepted.watch_urls[0]}`);
    process.stdout.write(`  \x1b[33m⏳ Pipeline executing...\x1b[0m`);

    // Poll until DONE or ERROR
    let result: ScenarioRunResult | null = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      process.stdout.write(".");
      const pollRes = await fetch(`${API_URL}/v1/demo/scenarios/runs/${runId}`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
      });
      if (pollRes.ok) {
        const body = (await pollRes.json()) as ScenarioRunResult;
        if (body.status === "DONE" || body.status === "ERROR") {
          result = body;
          break;
        }
      }
    }

    console.log(""); // newline after spinner

    if (!result) {
      console.error(`\x1b[1;31m✖ Timeout waiting for scenario execution to conclude.\x1b[0m`);
      return false;
    }

    // Print assertions summary table
    console.log(`\n  \x1b[1mExpected Outcome:\x1b[0m ${result.expected_outcome}`);
    console.log(`  \x1b[1mActual Outcome:  \x1b[0m \x1b[1;35m${result.actual_outcome}\x1b[0m`);
    console.log(`\n  \x1b[1mSelf-Grading Assertion Verdicts:\x1b[0m`);
    console.log(`  ┌─────────────────────────────────────┬────────┬──────────────────────────────────────────┐`);
    console.log(`  │ Assertion Name                      │ Status │ Detail                                   │`);
    console.log(`  ├─────────────────────────────────────┼────────┼──────────────────────────────────────────┤`);

    for (const a of result.assertions) {
      const name = a.name.padEnd(35).slice(0, 35);
      const status = a.pass ? "\x1b[1;32mPASS  \x1b[0m" : "\x1b[1;31mFAIL  \x1b[0m";
      const detail = a.detail.padEnd(40).slice(0, 40);
      console.log(`  │ ${name} │ ${status} │ ${detail} │`);
    }
    console.log(`  └─────────────────────────────────────┴────────┴──────────────────────────────────────────┘`);

    if (result.pass) {
      console.log(`  \x1b[1;42;30m SUCCESS \x1b[0m \x1b[1;32mAll assertions passed for ${scenario}.\x1b[0m\n`);
      return true;
    } else {
      console.log(`  \x1b[1;41;37m FAILURE \x1b[0m \x1b[1;31mOne or more assertions failed.\x1b[0m\n`);
      return false;
    }
  } catch (e: any) {
    console.error(`\x1b[1;31m✖ Connection error:\x1b[0m ${e.message ?? String(e)}`);
    console.log(`  (Is the GrowthAgent API server running on port ${PORT}?)`);
    return false;
  }
}

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? "all").toLowerCase();

  console.log(`\n\x1b[1;35m╔══════════════════════════════════════════════════════════════════════╗\x1b[0m`);
  console.log(`\x1b[1;35m║\x1b[0m \x1b[1;37mGrowthAgent — Autonomous AI Growth with ONE Deterministic Gatekeeper\x1b[0m \x1b[1;35m║\x1b[0m`);
  console.log(`\x1b[1;35m║\x1b[0m \x1b[36mRazorpay AI Buildathon · Judge Automated Demo Driver Suite          \x1b[0m \x1b[1;35m║\x1b[0m`);
  console.log(`\x1b[1;35m╚══════════════════════════════════════════════════════════════════════╝\x1b[0m`);

  if (arg === "all") {
    let passed = 0;
    for (const s of SCENARIOS) {
      const ok = await runSingleScenario(s.name, s.title, s.beat);
      if (ok) passed++;
    }
    console.log(`\x1b[1;36m======================================================================\x1b[0m`);
    console.log(`\x1b[1mSummary:\x1b[0m \x1b[1;32m${passed}\x1b[0m / \x1b[1m${SCENARIOS.length}\x1b[0m scenarios passed cleanly.`);
    console.log(`\x1b[1;36m======================================================================\x1b[0m\n`);
    process.exit(passed === SCENARIOS.length ? 0 : 1);
  } else {
    const match = SCENARIOS.find((s) => s.name === arg);
    if (!match) {
      console.error(`Unknown scenario '${arg}'. Choose one of: ${SCENARIOS.map((s) => s.name).join(", ")}, or 'all'.`);
      process.exit(1);
    }
    const ok = await runSingleScenario(match.name, match.title, match.beat);
    process.exit(ok ? 0 : 1);
  }
}

void main();
