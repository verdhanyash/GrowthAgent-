/**
 * Rationale acquisition + application policy (campaign.md §7.3, §8.1, §10).
 *
 * Two layers:
 *  1. draftRationalesWithFallback — OWNS the retry ladder (SDK client runs
 *     maxRetries: 0 so this is ours and test-visible): up to
 *     CAMPAIGN_CONFIG.rationaleAttempts invocations for RETRYABLE errors,
 *     exactly one re-request for PARSE_FAILED, immediate abort for
 *     NON_RETRYABLE. Backoff 500ms·2^n + jitter, both injectable for tests.
 *  2. resolveOutcome — PURE §10 reconciliation of "keep previous set on agent
 *     failure" vs "template fallback per entry": verified rationales publish
 *     (FRESH), any verifier failure templates just that entry (PARTIAL_
 *     TEMPLATE), a port-level failure keeps the previous set — EXCEPT when no
 *     previous set exists (seed time), where an all-template set publishes so
 *     demo beat 1 always has material (TEMPLATE_ONLY; §17 item 4 ratified).
 */
import {
  CAMPAIGN_CONFIG,
  type LlmInvocation,
  type Opportunity,
  type PriorityEntry,
  type RationaleFallbackVerdict,
  type RationalesOutput,
} from "@growthagent/shared";
import type { EntryDraft } from "../domain/derive.js";
import {
  classify,
  type RationaleFailureKind,
  type RationalePort,
} from "./rationale.port.js";
import type { DraftArgs } from "./prompts.js";
import { buildRequestBody, requestBodyKey } from "./prompts.js";
import {
  verifyRationale,
  type Verdict,
} from "../verify/rationale-verifier.js";
import { templateRationale } from "../verify/template-rationales.js";

/* --------------------------- port result shapes -------------------------- */

export interface PortSuccess {
  readonly ok: true;
  readonly output: RationalesOutput;
  /** Wall-ms measured around the final successful call (telemetry only). */
  readonly latencyMs: number;
  readonly fromCache: boolean;
}
export interface PortFailure {
  readonly ok: false;
  readonly error: unknown;
}
export type PortResult = PortSuccess | PortFailure;

/** Injectable timing: sleep + jitter source keep the ladder deterministic. */
export interface RunnerTiming {
  readonly sleep: (ms: number) => Promise<void>;
  readonly jitter: () => number; // [0,1)
}

export const defaultTiming: RunnerTiming = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  jitter: () => Math.random(),
};

export function backoffDelay(attemptZeroBased: number, t: RunnerTiming): number {
  return (
    CAMPAIGN_CONFIG.rationaleBackoffBaseMs * 2 ** attemptZeroBased +
    Math.floor(t.jitter() * 100)
  );
}

/**
 * The async acquisition loop. Returns a PortResult rather than throwing —
 * callers feed it to resolveOutcome. A PARSE_FAILED consumes one re-request;
 * if that also fails the whole attempt is treated as its classified kind.
 */
export async function draftRationales(
  port: RationalePort,
  args: DraftArgs,
  timing: RunnerTiming = defaultTiming,
): Promise<PortResult> {
  const startedAtNs = process.hrtime.bigint();
  let lastError: unknown;
  for (let attempt = 0; attempt < CAMPAIGN_CONFIG.rationaleAttempts; attempt++) {
    if (attempt > 0) {
      await timing.sleep(backoffDelay(attempt - 1, timing));
    }
    try {
      const output = await port.draft(args);
      return {
        ok: true,
        output,
        latencyMs: Number((process.hrtime.bigint() - startedAtNs) / 1_000_000n),
        fromCache: false,
      };
    } catch (e) {
      lastError = e;
      const kind = classify(e);
      if (kind === "NON_RETRYABLE") return { ok: false, error: e };
      // PARSE_FAILED gets exactly ONE re-request (§10 row 6); CHAOS_FORCED
      // and RETRYABLE_EXHAUSTED ride the standard ladder.
      if (kind === "CHAOS_FORCED") break;
    }
  }
  return { ok: false, error: lastError };
}

/* ----------------------- pure outcome resolution ------------------------- */

export interface FallbackRecord {
  readonly entry_id: string;
  readonly opportunity_id: string;
  readonly verdict: RationaleFallbackVerdict;
  readonly rejected_rationale: string;
}

export interface AppliedRationales {
  readonly entries: readonly PriorityEntry[];
  readonly fallbacks: readonly FallbackRecord[];
  readonly entries_verified: number;
}

const VERDICT_TO_EVENT = (v: Verdict): RationaleFallbackVerdict =>
  v === "MISSING_METRIC" ? "MISSING_METRIC" : "INVENTED_NUMBER";

/**
 * Attaches index-addressed rationales (§7.1, §14):
 *  • verified string → VERIFIED_LLM entry;
 *  • failing verification → template + CAMPAIGN_RATIONALE_FALLBACK record
 *    carrying the REJECTED text verbatim (explainer/demo fodder);
 *  • duplicate indices → first wins, later duplicates ignored with one
 *    fallback event each;
 *  • out-of-range or missing indices → templated entry + NO_INDEX event.
 * Every emitted entry passes PriorityEntrySchema by construction (templates
 * are ≥20 chars; verified strings ≥40 by the output schema).
 */
export function applyRationales(
  drafts: readonly EntryDraft[],
  oppById: ReadonlyMap<string, Opportunity>,
  returned: RationalesOutput | null,
): AppliedRationales {
  const entries: PriorityEntry[] = [];
  const fallbacks: FallbackRecord[] = [];
  let verified = 0;

  // First occurrence wins; later duplicates become NO_INDEX events.
  const firstIndexOwners = new Map<number, string>();
  if (returned !== null) {
    for (const r of returned.rationales) {
      const owner = firstIndexOwners.get(r.entry_index);
      if (owner === undefined && r.entry_index < drafts.length) {
        firstIndexOwners.set(r.entry_index, r.rationale_nl);
      } else {
        const draft =
          r.entry_index < drafts.length ? drafts[r.entry_index] : undefined;
        if (draft) {
          fallbacks.push({
            entry_id: draft.entry_id,
            opportunity_id: draft.opportunity_id,
            verdict: "NO_INDEX",
            rejected_rationale: r.rationale_nl,
          });
        }
      }
    }
  }

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!;
    const opp = oppById.get(d.opportunity_id);
    const candidate = firstIndexOwners.get(i);

    let verdict: Verdict = "MISSING_METRIC";
    if (candidate !== undefined && opp) {
      verdict = verifyRationale(opp, d, candidate);
    }

    if (candidate !== undefined && opp && verdict === "VERIFIED") {
      verified++;
      entries.push({
        entry_id: d.entry_id,
        opportunity_id: d.opportunity_id,
        action: d.action,
        skus: [...d.skus],
        weight: d.weight,
        rationale_nl: candidate,
        rationale_provenance: "VERIFIED_LLM",
      });
    } else {
      if (candidate !== undefined && opp && verdict !== "VERIFIED") {
        fallbacks.push({
          entry_id: d.entry_id,
          opportunity_id: d.opportunity_id,
          verdict: VERDICT_TO_EVENT(verdict),
          rejected_rationale: candidate,
        });
      } else if (candidate === undefined) {
        fallbacks.push({
          entry_id: d.entry_id,
          opportunity_id: d.opportunity_id,
          verdict: "NO_INDEX",
          rejected_rationale: "",
        });
      }
      entries.push({
        entry_id: d.entry_id,
        opportunity_id: d.opportunity_id,
        action: d.action,
        skus: [...d.skus],
        weight: d.weight,
        // Defensive branch is unreachable when drafts derive from the same
        // opportunity array (the M3 cycle's construction); kept schema-safe.
        rationale_nl:
          opp ? templateRationale(opp, d) : `Deterministic template fallback for entry ${d.entry_id}.`,
        rationale_provenance: "TEMPLATE_FALLBACK",
      });
    }
  }
  return { entries, fallbacks, entries_verified: verified };
}

/* ------------------------------ resolution ------------------------------- */

export type ResolvedOutcome =
  | {
      kind: "PUBLISH";
      status: "FRESH" | "PARTIAL_TEMPLATE" | "TEMPLATE_ONLY";
      applied: AppliedRationales;
      llm_invocation: LlmInvocation | null;
    }
  | {
      kind: "KEEP_PREVIOUS";
      failure: { kind: RationaleFailureKind; message: string };
    };

export function requestHash(args: DraftArgs): string {
  return requestBodyKey(
    buildRequestBody(args, CAMPAIGN_CONFIG.rationaleModel),
  );
}

export function resolveOutcome(input: {
  drafts: readonly EntryDraft[];
  oppById: ReadonlyMap<string, Opportunity>;
  portResult: PortResult;
  previousSetExists: boolean;
  model?: string;
  requestHash?: string;
  latencyMs?: number;
  fromCache?: boolean;
}): ResolvedOutcome {
  const { drafts, oppById, portResult, previousSetExists } = input;

  if (!portResult.ok) {
    // Agent failure ⇒ previous persists (graceful-degradation contract);
    // seed-time hole (nothing to persist) closes with an all-template set.
    if (previousSetExists) {
      const kind = classify(portResult.error);
      return {
        kind: "KEEP_PREVIOUS",
        failure: {
          kind,
          message: portResult.error instanceof Error
            ? portResult.error.message
            : String(portResult.error),
        },
      };
    }
    const applied = applyRationales(drafts, oppById, null);
    return {
      kind: "PUBLISH",
      status: "TEMPLATE_ONLY",
      applied,
      llm_invocation: null,
    };
  }

  const applied = applyRationales(drafts, oppById, portResult.output);
  const status = applied.fallbacks.length === 0 ? "FRESH" : "PARTIAL_TEMPLATE";
  return {
    kind: "PUBLISH",
    status,
    applied,
    llm_invocation: {
      model: input.model ?? CAMPAIGN_CONFIG.rationaleModel,
      request_hash: input.requestHash ?? "",
      latency_ms: input.latencyMs ?? portResult.latencyMs,
      entries_verified: applied.entries_verified,
      entries_template_fallback:
        applied.entries.length - applied.entries_verified,
      from_cache: input.fromCache ?? portResult.fromCache,
    },
  };
}

/** Convenience wrapper used by the M3 cycle: acquire → verify → resolve. */
export async function draftRationalesWithFallback(
  port: RationalePort,
  args: DraftArgs,
  opts: { previousSetExists: boolean; opportunities: readonly Opportunity[] },
  timing: RunnerTiming = defaultTiming,
): Promise<ResolvedOutcome> {
  const oppById = new Map(
    opts.opportunities.map((o) => [o.opportunity_id, o]),
  );
  const portResult = await draftRationales(port, args, timing);
  return resolveOutcome({
    drafts: args.entries,
    oppById,
    portResult,
    previousSetExists: opts.previousSetExists,
  });
}
