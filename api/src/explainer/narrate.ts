/**
 * Narration runner — the explainer's committed degradation contract
 * (gatekeeper.md, api-contract.md, frontend-events.md §6 note 16 all agree):
 *
 *   LLM success + verification pass → ONE narrative ships
 *     (non_authoritative: true — the type forbids anything else; degraded:
 *     false).
 *   LLM failure OR verification rejection → NOTHING ships. The raw rule-trace
 *     JSON stands as the explanation. `degraded=true` narratives are never
 *     emitted (§18 register); the caller omits the explanation_narrative
 *     event and the DECLINED terminal outcome simply carries no
 *     narrated_explanation.
 *
 * The rejected narrative text is preserved in the NONE result so the audit
 * trail can show "what the AI tried" (same containment pattern as the
 * campaign's CAMPAIGN_RATIONALE_FALLBACK.rejected_rationale).
 */
import {
  ExplanationNarrativeSchema,
  type ExplanationNarrative,
  verifyNarration,
  type VerifyContext,
} from "@growthagent/shared";
import {
  classify,
  type NarratorPort,
} from "./narrator.port.js";
import type { NarrateArgs } from "./prompts.js";

export interface RunnerTiming {
  readonly sleep: (ms: number) => Promise<void>;
  readonly jitter: () => number; // [0,1)
}

export const defaultTiming: RunnerTiming = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  jitter: () => Math.random(),
};

const ATTEMPTS = 2;
const BACKOFF_BASE_MS = 500;

function backoffDelay(attemptZeroBased: number, t: RunnerTiming): number {
  return BACKOFF_BASE_MS * 2 ** attemptZeroBased + Math.floor(t.jitter() * 100);
}

export type NarrationResult =
  | { readonly kind: "NARRATIVE"; readonly narrative: ExplanationNarrative }
  | {
      readonly kind: "NONE";
      readonly reason: { kind: string; message: string };
    };

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export async function narrate(
  port: NarratorPort,
  args: NarrateArgs,
  verifyCtx: VerifyContext,
  timing: RunnerTiming = defaultTiming,
): Promise<NarrationResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await timing.sleep(backoffDelay(attempt - 1, timing));
    try {
      const output = await port.narrate(args);
      const verdict = verifyNarration(output, verifyCtx);

      if (!verdict.ok) {
        return {
          kind: "NONE",
          reason: {
            kind: verdict.rejection,
            message: `${verdict.detail}; rejected text kept for audit: "${output.body_md.slice(0, 200)}"`,
          },
        };
      }

      const candidate: ExplanationNarrative = {
        audience: args.audience,
        title: output.title.trim(),
        body_md: output.body_md.trim(),
        non_authoritative: true, // literal(true) — the type IS the firewall
        grounded_on_events: [...output.grounded_on_events].sort((a, b) => a - b),
        degraded: false, // v1 never ships degraded narratives (§18 register)
      };
      // Parse through the SSE payload schema so what we emit is contract-valid
      // by construction.
      return {
        kind: "NARRATIVE",
        narrative: ExplanationNarrativeSchema.parse(candidate),
      };
    } catch (e) {
      lastError = e;
      if (classify(e) === "NON_RETRYABLE") break;
      if (classify(e) === "CHAOS_FORCED") break;
    }
  }
  return {
    kind: "NONE",
    reason: { kind: classify(lastError), message: messageOf(lastError) },
  };
}

/** Convenience: the VerifyContext most callers build from their timeline. */
export function verifyContextFor(
  events: readonly { seq: number }[],
  untrustedTexts: readonly string[],
): VerifyContext {
  return {
    candidateSeqs: new Set(events.map((e) => e.seq)),
    untrustedTexts,
  };
}
