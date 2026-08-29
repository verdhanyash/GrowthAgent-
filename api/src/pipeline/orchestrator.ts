/**
 * Pipeline orchestrator — ARCHITECTURE.md §3 flow, one buyer proposal end to
 * end:
 *
 *   INTAKE → CONTEXT_BUILD → CAMPAIGN_INJECT → NEGOTIATION → CITATION_AUDIT
 *     → GATEKEEPER ─┬─ APPROVE  → SETTLEMENT → (AWAITING_PAYMENT) → EXPLAIN
 *                   ├─ DECLINE  → TERMINAL(DECLINED)              → EXPLAIN
 *                   └─ ESCALATE → approval inbox (ESCALATION_WAIT) → EXPLAIN
 *                                 ├─ approve → resume settlement on FROZEN bytes
 *                                 └─ reject  → TERMINAL(DECLINED)
 *
 * Every durable transition emits through the hash-chained TraceEmitter; the
 * SSE stream IS the audit log. The AI layers propose; settlement executes
 * exactly the gatekeeper-approved bytes (SettleableProposal minted from the
 * GATEKEEPER'S recomputed totals — never from AI-supplied numbers).
 */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  digestView,
  MEERA_RULES_V3,
  type AgentVelocitySnapshot,
  type CampaignPriorityPayload,
  type CitationAuditResult,
  type GatekeeperResult,
  type GroundTruthSnapshot,
  type MerchantRulesConfig,
  type NegotiationProposal,
  type RuleId,
  type SettleableProposal,
  type StageName,
} from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { appendAudit } from "../audit/writer.js";
import type { Clock } from "../settlement/clock.js";
import { settle } from "../settlement/settle.js";
import { SettlementRejectedError } from "../settlement/errors.js";
import { evaluateProposal } from "../gatekeeper/engine.js";
import type { BuyerRequestView } from "@growthagent/shared";
import { runNegotiation } from "../negotiation/stage.js";
import type { NegotiationTransport } from "../negotiation/transport.types.js";
import type { NarratorPort } from "../explainer/narrator.port.js";
import { narrate } from "../explainer/narrate.js";
import type { TimelineEvent } from "@growthagent/shared";
import type { NarratorAudience } from "@growthagent/shared";
import type { SettlementConfig } from "../settlement/config.js";
import type { SettlementProvider } from "../settlement/provider/types.js";
import type { VelocityInput } from "../settlement/reserve.js";
import { AuditChain } from "./audit-chain.js";
import type { ChainActor } from "./audit-chain.js";
import { toProposedCart } from "./cart-adapter.js";
import { PipelineEmitter, systemActor } from "./emitter.js";
import { scanCustomerNote, type TaggerOutput } from "./tagger.js";
import { buildEvidencePack } from "./evidence.js";
import { createApproval, makeApprovalTokenConsumer, mintApprovalCredentials, resolveApproval } from "./approvals.js";

/* ------------------------------- seams ---------------------------------- */

export interface PipelineDeps {
  readonly db: PgPool;
  readonly clock: Clock;
  readonly chain: AuditChain;
  readonly emitter: PipelineEmitter;
  readonly transport: NegotiationTransport;
  /** Absent ⇒ EXPLAIN degrades honestly to RAW_RULE_TRACE_JSON. */
  readonly narrator?: NarratorPort | undefined;
  readonly groundTruth: () => Promise<GroundTruthSnapshot>;
  /** Active PrioritySet payloads (empty allowed — R6 covers honesty). */
  readonly priorities: () => Promise<readonly CampaignPriorityPayload[]>;
  readonly rules: () => Promise<MerchantRulesConfig> | MerchantRulesConfig;
  readonly velocity?: ((agentId: string) => Promise<AgentVelocitySnapshot>) | undefined;
  readonly provider: SettlementProvider;
  readonly settleConfig: SettlementConfig;
  /** Ceilings handed down to reserve-time velocity enforcement (TB-2b). */
  readonly reserveVelocity?: VelocityInput | undefined;
  readonly approvalTtlMs: number;
}

export interface RunInput {
  readonly tx_id: string;
  readonly agent: { readonly agent_id: string; readonly key_hash: string };
  readonly buyer_request: BuyerRequestView;
  readonly customer_note_raw: string;
  readonly merchant_id: string;
}

export type RunTerminal =
  | { readonly kind: "AWAITING_PAYMENT"; readonly rzp_order_id: string }
  | { readonly kind: "DECLINED" }
  | { readonly kind: "ESCALATED"; readonly approval_id: string; readonly expires_at: string }
  | { readonly kind: "FAILED"; readonly reason: string; readonly retryable: boolean };

export interface RunResult {
  readonly tx_id: string;
  readonly terminal: RunTerminal;
  readonly head_seq: number;
}

export class PipelineAlreadyRunError extends Error {
  constructor(readonly tx_id: string) {
    super(`pipeline already ran (or is running) for ${tx_id}`);
    this.name = "PipelineAlreadyRunError";
  }
}

const PIPELINE_ACTOR = systemActor("pipeline", "PIPELINE");

/* ------------------------------ entrypoint ------------------------------ */

export async function runPipeline(deps: PipelineDeps, input: RunInput): Promise<RunResult> {
  const { db, emitter } = deps;
  const nowIsoOf = () => new Date(deps.clock.nowMs()).toISOString();

  // Claim the tx (unique PK): replays never re-enter the pipeline here — the
  // HTTP layer resolves idempotent replays BEFORE enqueueing (M8).
  const claimed = await db.query(
    `INSERT INTO proposal_txs (tx_id, agent_id, agent_key_hash, request_bytes, stage)
     VALUES ($1,$2,$3,$4,'PROPOSING') ON CONFLICT (tx_id) DO NOTHING`,
    [input.tx_id, input.agent.agent_id, input.agent.key_hash,
      JSON.stringify({ buyer_request: input.buyer_request, customer_note_raw: input.customer_note_raw })],
  );
  if ((claimed.rowCount ?? 0) === 0) throw new PipelineAlreadyRunError(input.tx_id);

  const ctx = new RunCtx(deps, input);

  /* ---- INTAKE ---------------------------------------------------------- */
  const taggerOut = await ctx.stage("INTAKE", async () => {
    const scanned = scanCustomerNote(input.customer_note_raw);
    if (scanned.signal.suspected) {
      await emitter.emit(input.tx_id, "injection_flagged", {
        detector: "HEURISTIC_TAGGER",
        patterns_matched: scanned.signal.hits.map((h) => h.pattern_id),
        matched_snippets: scanned.signal.hits.map((h) => h.snippet),
        severity: scanned.signal.risk_score >= 40 ? "HIGH" : scanned.signal.risk_score >= 20 ? "MEDIUM" : "LOW",
        // The matched snippets already carry the forensic signal; the full note
        // is durably persisted in proposal_txs.request_bytes. We publish only a
        // bounded preview over SSE so a hostile note can't dump unbounded
        // attacker-controlled text to every subscribed dashboard.
        customer_note_preview: input.customer_note_raw.slice(0, 280),
        customer_note_len: input.customer_note_raw.length,
        agent_identity_hash: input.agent.key_hash,
        velocity_counter_incremented: false,
      }, PIPELINE_ACTOR);
    }
    return scanned;
  });

  /* ---- CONTEXT_BUILD --------------------------------------------------- */
  // Priorities are FETCHED here so the emitted pack already carries their
  // CAMPAIGN_PRIORITY entries (the model may only cite what the pack shows —
  // R1 integrity); the dedicated stage below is where they're ANNOUNCED.
  const { gt, priorities, pack } = await ctx.stage("CONTEXT_BUILD", async () => {
    await ctx.setStage("BUILDING_EVIDENCE");
    const snapshot = await deps.groundTruth();
    const active = await deps.priorities();
    const built = buildEvidencePack({
      gt: snapshot,
      priorities: active,
      simToday: nowIsoOf().slice(0, 10),
      nowIso: nowIsoOf(),
    });
    await emitter.emit(input.tx_id, "evidence_pack_built", { pack: built }, PIPELINE_ACTOR);
    return { gt: snapshot, priorities: active, pack: built };
  });

  /* ---- CAMPAIGN_INJECT -------------------------------------------------- */
  await ctx.stage("CAMPAIGN_INJECT", async () => {
    await emitter.emit(input.tx_id, "campaign_priority_injected", {
      priority_set_id: "active",
      generated_at: nowIsoOf(),
      degraded: false,
      priorities: priorities.map((p) => ({
        priority_id: p.priority_id,
        action: p.action,
        target_skus: p.target_skus,
        weight: p.weight,
        rationale_plain_language: p.rationale_plain,
      })),
    }, PIPELINE_ACTOR);
  });

  /* ---- NEGOTIATION ------------------------------------------------------ */
  const neg = await ctx.stage("NEGOTIATION", async () => {
    await ctx.setStage("NEGOTIATING");
    const t0 = deps.clock.nowMs();
    const out = await runNegotiation(
      {
        tx_id: input.tx_id,
        sim_today: nowIsoOf().slice(0, 10),
        now_iso: nowIsoOf(),
        merchant_id: input.merchant_id,
        pack,
        priorities,
        buyer_request: input.buyer_request,
        customer_note_raw: input.customer_note_raw,
        tags: taggerOut.tags,
      },
      { transport: deps.transport },
    );
    if (out.outcome === "FALLBACK") {
      await emitter.emit(input.tx_id, "degraded", {
        stage: "NEGOTIATION",
        cause: degradedCause(out.llm_failure_reason),
        fallback_engaged: "RULE_BASED_FALLBACK_BUNDLE",
        chaos_forced: false,
      }, PIPELINE_ACTOR);
    }
    await emitter.emit(input.tx_id, "proposal_ready", {
      proposal: out.proposal,
      generator: out.provenance.generator,
      is_fallback: out.provenance.is_fallback,
      degraded: out.provenance.is_fallback,
      latency_ms: deps.clock.nowMs() - t0,
    }, PIPELINE_ACTOR);
    return out;
  });

  /* ---- CITATION_AUDIT --------------------------------------------------- */
  const auditSeq = await ctx.stage("CITATION_AUDIT", async () => {
    await ctx.setStage("CITATION_AUDIT");
    const audit = neg.citation_audit ?? neg.fallback_audit;
    let seq: number | null = null;
    if (audit !== null) {
      seq = await emitAuditResult(emitter, input.tx_id, audit);
    }
    return { audit, seq };
  });
  if (auditSeq.seq !== null) ctx.noteGroundable(auditSeq.seq, "citation_audit_result", auditSeq.audit);

  /* ---- GATEKEEPER ------------------------------------------------------- */
  const gate = await ctx.stage("GATEKEEPER", async () => {
    await ctx.setStage("GATE_CHECKING");
    const rules = await deps.rules();
    const velocity =
      deps.velocity !== undefined
        ? await deps.velocity(input.agent.agent_id)
        : emptyVelocity(input.agent.agent_id, nowIsoOf());
    const t0 = deps.clock.nowMs();
    const result = evaluateProposal({
      proposal: toProposedCart({
        proposal: neg.proposal,
        txId: input.tx_id,
        buyerAgentIdentityId: input.agent.agent_id,
        customerNoteRaw: input.customer_note_raw,
        groundTruth: gt,
        nowMs: deps.clock.nowMs(),
      }),
      rules,
      ground_truth: gt,
      velocity,
      injection: taggerOut.signal,
      now_iso: nowIsoOf(),
      tx_id: input.tx_id,
    });
    // Pin the governing rules version on the tx (E-09) so the HTTP poll can
    // surface `rules_version_applied` for every terminal outcome.
    await db.query(`UPDATE proposal_txs SET rules_version=$2, updated_at=now() WHERE tx_id=$1`, [
      input.tx_id,
      result.rules_version,
    ]);
    const runId = `gkrun_${createHash("sha256").update(result.input_digest).digest("hex").slice(0, 12)}`;
    for (const e of result.trace) {
      const seq = await emitter.emit(input.tx_id, "gatekeeper_rule_result", {
        run_id: runId,
        // Registry ids are drawn from RULE_IDS; the trace widens them to string.
        rule_id: e.rule_id as RuleId,
        status: e.status,
        severity: e.severity,
        expected: e.expected,
        actual: e.actual,
        human_message: e.human_message,
        reason_code: e.reason_code,
        evidence: e.evidence,
      }, systemActor("gatekeeper", "GATEKEEPER"));
      ctx.noteGroundable(seq, "gatekeeper_rule_result", {
        run_id: runId, rule_id: e.rule_id, status: e.status, severity: e.severity,
        expected: e.expected, actual: e.actual, human_message: e.human_message,
        reason_code: e.reason_code, evidence: e.evidence,
      });
    }
    const decisionPayload = {
      decision: result.outcome,
      rules_version_evaluated: result.rules_version,
      input_digest: result.input_digest,
      declines: result.declines.map((d) => ({
        rule_id: d.rule_id, reason_code: d.reason_code, human_message: d.human_message,
      })),
      escalations: result.escalations.map((d) => ({
        rule_id: d.rule_id, reason_code: d.reason_code, human_message: d.human_message,
      })),
      total_duration_ms: deps.clock.nowMs() - t0,
    };
    const decisionSeq = await emitter.emit(
      input.tx_id, "gatekeeper_decision", decisionPayload, systemActor("gatekeeper", "GATEKEEPER"),
    );
    ctx.noteGroundable(decisionSeq, "gatekeeper_decision", decisionPayload);
    return result;
  });

  /* ---- ROUTE ------------------------------------------------------------ */
  if (gate.outcome === "APPROVE") {
    const settleable = mintSettleable({
      txId: input.tx_id,
      proposal: neg.proposal,
      gt,
      gate,
      approvalSource: "GATEKEEPER_AUTO",
    });
    const terminal = await ctx.settlement(settleable);
    // Persist the terminal outcome (mirrors the resume path) — AWAITING_PAYMENT
    // is NON-terminal: the payment webhook, not the pipeline, finishes the tx.
    await ctx.finishNonTerminal("SETTLING", terminalOutcomeJson(terminal));
    await ctx.explain("AUDIT_TRAIL");
    return { tx_id: input.tx_id, terminal, head_seq: deps.chain.headSeq() };
  }

  if (gate.outcome === "DECLINE") {
    await ctx.finishTerminal("TERMINAL", {
      outcome: "DECLINED",
      decline_reasons: gate.declines.map((d) => ({
        rule_id: d.rule_id,
        message: d.human_message,
        ...(d.reason_code ? { reason_code: d.reason_code } : {}),
      })),
    });
    await ctx.explain("DECLINE_EXPLAINER");
    return { tx_id: input.tx_id, terminal: { kind: "DECLINED" }, head_seq: deps.chain.headSeq() };
  }

  /* ESCALATE: freeze EXACTLY the settleable bytes; the inbox settles them.
   * The single-use token is minted FIRST and baked into the proposal so its
   * proposal_sha256 binds it — settle() re-checks that exact digest, then burns
   * the token. (The token can't be added at resume: digestView includes it.) */
  const cred = mintApprovalCredentials(input.tx_id, deps.clock.nowMs());
  const settleableEsc = mintSettleable({
    txId: input.tx_id,
    proposal: neg.proposal,
    gt,
    gate,
    approvalSource: "HUMAN_ESCALATION",
    approvalToken: cred.approval_token,
  });
  const bandReason = escalateReason(gate);
  const approval = await createApproval(deps.db, {
    tx_id: input.tx_id,
    reason: bandReason.reason,
    band_context: bandReason.band_context,
    frozen_proposal: settleableEsc,
    gate_trace_summary: {
      input_digest: gate.input_digest,
      escalations: gate.escalations,
      summary: gate.summary,
    },
    ttlMs: deps.approvalTtlMs,
    now: new Date(deps.clock.nowMs()),
    approval_id: cred.approval_id,
  });
  await emitter.emit(input.tx_id, "escalation_created", {
    escalation_id: approval.approval_id,
    reason_codes: [bandReason.reason],
    expires_at: approval.expires_at,
    proposed_cart: {
      lines: settleableEsc.lines,
      subtotal_paise: settleableEsc.lines.reduce((s, l) => s + l.unit_price_paise * l.qty, 0),
      discount_percent_bps: 0,
      discount_paise: 0,
      total_paise: settleableEsc.total_amount_paise,
    },
    rule_trace_ref: { run_id: gate.input_digest.slice(0, 16), trace_digest: gate.input_digest },
  }, PIPELINE_ACTOR);
  await ctx.setStage("AWAITING_HUMAN_APPROVAL");
  await ctx.finishNonTerminal("AWAITING_HUMAN_APPROVAL", {
    outcome: "ESCALATED",
    approval_id: approval.approval_id,
    expires_at: approval.expires_at,
  });
  await ctx.explain("APPROVAL_ASSIST");
  return {
    tx_id: input.tx_id,
    terminal: { kind: "ESCALATED", approval_id: approval.approval_id, expires_at: approval.expires_at },
    head_seq: deps.chain.headSeq(),
  };
}

/* ------------------------- escalation resolution ------------------------ */

export interface ResolveDeps extends Pick<PipelineDeps, "db" | "clock" | "chain" | "emitter"> {
  readonly provider: SettlementProvider;
  readonly settleConfig: SettlementConfig;
  readonly reserveVelocity?: VelocityInput | undefined;
}

/**
 * Human approved → resume settlement on the FROZEN bytes (never re-proposed).
 * Token consumption happens INSIDE settle(); the frozen proposal stays in the
 * approvals row so a crashed resume can be re-driven by hand/sweeper.
 */
export async function resumeAfterApproval(
  deps: ResolveDeps,
  args: { approval_id: string; decided_by: string; note?: string | undefined },
): Promise<{ already: true } | { already: false; terminal: RunTerminal }> {
  const resolved = await resolveApproval(deps.db, {
    approval_id: args.approval_id,
    decision: "APPROVED",
    decided_by: args.decided_by,
    note: args.note,
    now: new Date(deps.clock.nowMs()),
  });
  if (resolved.already) return { already: true };
  const row = resolved.row;
  await deps.emitter.emit(row.tx_id, "escalation_approved", {
    escalation_id: row.approval_id,
    decision: "APPROVED",
    decided_by: args.decided_by,
    decided_at: new Date(deps.clock.nowMs()).toISOString(),
    ...(args.note !== undefined ? { note: args.note } : {}),
  }, systemActor("inbox", "SYSTEM"));
  await setStage(deps.db, row.tx_id, "SETTLING");
  const ctx = new RunCtx(makePartialDeps(deps), await resumeInputFor(deps.db, row.tx_id));
  const terminal = await ctx.settlement(row.frozen_proposal);
  await ctx.finishNonTerminal("SETTLING", terminalOutcomeJson(terminal));
  return { already: false, terminal };
}

/** Human rejected → terminal DECLINED with the human reason code. */
export async function rejectAfterRejection(
  deps: ResolveDeps,
  args: { approval_id: string; decided_by: string; note?: string | undefined },
): Promise<{ already: true } | { already: false }> {
  const resolved = await resolveApproval(deps.db, {
    approval_id: args.approval_id,
    decision: "REJECTED",
    decided_by: args.decided_by,
    note: args.note,
    now: new Date(deps.clock.nowMs()),
  });
  if (resolved.already) return { already: true };
  const row = resolved.row;
  await deps.emitter.emit(row.tx_id, "escalation_rejected", {
    escalation_id: row.approval_id,
    decision: "REJECTED",
    decided_by: args.decided_by,
    decided_at: new Date(deps.clock.nowMs()).toISOString(),
    ...(args.note !== undefined ? { note: args.note } : {}),
  }, systemActor("inbox", "SYSTEM"));
  await dbFinish(deps.db, row.tx_id, "TERMINAL", {
    outcome: "DECLINED",
    decline_reasons: [
      {
        rule_id: "ESCALATION_REJECTED_BY_HUMAN",
        message: args.note ?? "merchant declined the escalated proposal",
      },
    ],
  });
  return { already: false };
}

/* ------------------------------ internals ------------------------------- */

/** Mutable-per-run state: groundable timeline + stage timing. */
class RunCtx {
  private readonly timeline: TimelineEvent[] = [];

  constructor(
    private readonly deps: PipelineDeps,
    private readonly input: RunInput,
  ) {}

  noteGroundable(seq: number, type: TimelineEvent["type"], payload: unknown): void {
    this.timeline.push({ seq, type, payload });
  }

  candidateSeqs(): Set<number> {
    return new Set(this.timeline.map((t) => t.seq));
  }

  async setStage(stage: StageName | "BUILDING_EVIDENCE" | string): Promise<void> {
    await setStage(this.deps.db, this.input.tx_id, stage);
  }

  /** Stage wrapper: started/completed events with duration; failures emit the
   *  typed error event + FAILED completion and RETHROW (routing decides what
   *  a failure means per stage). */
  async stage<T>(name: StageName, fn: () => Promise<T>): Promise<T> {
    const t0 = this.deps.clock.nowMs();
    await this.deps.emitter.emit(this.input.tx_id, "stage_started", { stage: name, attempt: 1 }, PIPELINE_ACTOR);
    try {
      const value = await fn();
      await this.deps.emitter.emit(this.input.tx_id, "stage_completed", {
        stage: name,
        duration_ms: this.deps.clock.nowMs() - t0,
        outcome: "OK",
      }, PIPELINE_ACTOR);
      return value;
    } catch (e) {
      await this.deps.emitter.emit(this.input.tx_id, "error", {
        stage: name,
        code: "INTERNAL",
        message: e instanceof Error ? e.message : String(e),
        retriable: true,
      }, PIPELINE_ACTOR).catch(() => {});
      await this.deps.emitter.emit(this.input.tx_id, "stage_completed", {
        stage: name,
        duration_ms: this.deps.clock.nowMs() - t0,
        outcome: "FAILED",
      }, PIPELINE_ACTOR).catch(() => {});
      throw e;
    }
  }

  /** The settlement stage shares its shape between auto-approve and resume. */
  async settlement(proposal: SettleableProposal): Promise<RunTerminal> {
    const { emitter, db, clock } = this.deps;
    const actor = systemActor("settlement.pipeline", "SETTLEMENT");
    await emitter.emit(this.input.tx_id, "settlement_step", {
      step: "STOCK_RESERVE", status: "STARTED", attempt: 1,
      provider_mode: this.deps.provider.kind === "mock" ? "MOCK" : "TEST_MODE",
    }, actor);
    try {
      const result = await settle(proposal, {
        db,
        provider: this.deps.provider,
        config: this.deps.settleConfig,
        clock,
        ...(this.deps.reserveVelocity !== undefined ? { velocity: this.deps.reserveVelocity } : {}),
        consumeApprovalToken: makeApprovalTokenConsumer(db),
        // Ownership stamp (E-11). An empty id is the resume path's "claim row
        // vanished" fallback — omit it so the column stays NULL (owned by
        // nobody) rather than storing a sentinel that could be presented.
      }, this.input.agent.agent_id === ""
        ? {}
        : { ownerAgentId: this.input.agent.agent_id });
      await emitter.emit(this.input.tx_id, "settlement_step", {
        step: "STOCK_RESERVE", status: "SUCCEEDED", attempt: 1,
        amount_paise: result.response.amount_paise, currency: "INR",
      }, actor);
      await emitter.emit(this.input.tx_id, "settlement_step", {
        step: "RAZORPAY_ORDER_CREATE", status: "SUCCEEDED", attempt: 1,
        razorpay_order_id: result.response.rzp_order_id ?? undefined,
        amount_paise: result.response.amount_paise, currency: "INR",
      }, actor);
      await emitter.emit(this.input.tx_id, "settlement_step", {
        step: "PAYMENT_AWAIT", status: "STARTED", attempt: 1,
        razorpay_order_id: result.response.rzp_order_id ?? undefined,
      }, actor);
      return {
        kind: "AWAITING_PAYMENT",
        rzp_order_id: result.response.rzp_order_id ?? "",
      };
    } catch (e) {
      const code = e instanceof SettlementRejectedError ? e.code : "ORDER_CREATE_FAILED";
      const retryable = e instanceof SettlementRejectedError && e.httpStatus === 503;
      await emitter.emit(this.input.tx_id, "settlement_step", {
        step: "RAZORPAY_ORDER_CREATE", status: "FAILED", attempt: 1, error_code: code,
      }, actor);
      appendAudit(this.input.tx_id, "pipeline", "settlement.step_failed", { code, retryable });
      return { kind: "FAILED", reason: code, retryable };
    }
  }

  async finishNonTerminal(stage: string, outcome: Record<string, unknown>): Promise<void> {
    await dbUpdate(this.deps.db, this.input.tx_id, stage, outcome, false);
  }

  async finishTerminal(stage: string, outcome: Record<string, unknown>): Promise<void> {
    await dbUpdate(this.deps.db, this.input.tx_id, stage, outcome, true);
  }

  /** EXPLAIN: narrate over ONLY this run's groundable envelopes; failure or a
   *  missing narrator ships NOTHING (raw trace stands — committed contract). */
  async explain(audience: NarratorAudience): Promise<void> {
    const { emitter, clock } = this.deps;
    const t0 = clock.nowMs();
    await emitter.emit(this.input.tx_id, "stage_started", { stage: "EXPLAIN", attempt: 1 }, PIPELINE_ACTOR);
    const port = this.deps.narrator;
    if (port === undefined || this.timeline.length === 0) {
      await emitter.emit(this.input.tx_id, "degraded", {
        stage: "EXPLAIN",
        cause: "LLM_ERROR",
        fallback_engaged: "RAW_RULE_TRACE_JSON",
        chaos_forced: false,
      }, PIPELINE_ACTOR);
      await emitter.emit(this.input.tx_id, "stage_completed", {
        stage: "EXPLAIN", duration_ms: clock.nowMs() - t0, outcome: "DEGRADED",
      }, PIPELINE_ACTOR);
      return;
    }
    const untrusted = [
      this.input.customer_note_raw,
      ...this.input.buyer_request.items.map((i) => i.label_free_text ?? i.sku ?? ""),
    ].filter((s) => s.length > 0);
    try {
      const result = await narrate(port, { audience, events: this.timeline, untrustedTexts: untrusted }, {
        candidateSeqs: this.candidateSeqs(),
        untrustedTexts: untrusted,
      });
      if (result.kind === "NARRATIVE") {
        await emitter.emit(this.input.tx_id, "explanation_narrative", {
          audience: result.narrative.audience,
          title: result.narrative.title,
          body_md: result.narrative.body_md,
          non_authoritative: true,
          grounded_on_events: result.narrative.grounded_on_events,
          degraded: false,
        }, systemActor("explainer", "EXPLAINER"));
        await emitter.emit(this.input.tx_id, "stage_completed", {
          stage: "EXPLAIN", duration_ms: clock.nowMs() - t0, outcome: "OK",
        }, PIPELINE_ACTOR);
      } else {
        // Rejected narration ships NOTHING; the rejection lands in the chain
        // as a raw audit row for the trail ("what the AI tried").
        appendAudit(this.input.tx_id, "explainer", "narration_rejected", {
          reason: result.reason.kind,
          detail: result.reason.message,
        });
        await emitter.emit(this.input.tx_id, "stage_completed", {
          stage: "EXPLAIN", duration_ms: clock.nowMs() - t0, outcome: "DEGRADED",
        }, PIPELINE_ACTOR);
      }
    } catch (e) {
      appendAudit(this.input.tx_id, "explainer", "narration_failed", {
        err: e instanceof Error ? e.message : String(e),
      });
      await emitter.emit(this.input.tx_id, "stage_completed", {
        stage: "EXPLAIN", duration_ms: clock.nowMs() - t0, outcome: "DEGRADED",
      }, PIPELINE_ACTOR);
    }
  }
}

function makePartialDeps(d: ResolveDeps): PipelineDeps {
  return {
    db: d.db,
    clock: d.clock,
    chain: d.chain,
    emitter: d.emitter,
    transport: stubTransportNeverCalled(),
    groundTruth: () => Promise.reject(new Error("not used in resume path")),
    priorities: () => Promise.resolve([]),
    rules: () => MEERA_RULES_V3,
    provider: d.provider,
    settleConfig: d.settleConfig,
    ...(d.reserveVelocity !== undefined ? { reserveVelocity: d.reserveVelocity } : {}),
    approvalTtlMs: 0,
  };
}

/** Minimal RunInput for the resume path. The buyer's REAL identity is recovered
 *  from the claim row (proposal_txs) rather than stubbed: `ctx.settlement` stamps
 *  `transactions.agent_id` from it, so an escalation-approved tx must end up
 *  owned by the buyer who submitted it — not by a sentinel that owns nothing and
 *  would 404 for its own author on `GET /v1/tx/:tx_id`. */
async function resumeInputFor(db: PgPool, txId: string): Promise<RunInput> {
  const r = await db.query(
    `SELECT agent_id, agent_key_hash FROM proposal_txs WHERE tx_id=$1`,
    [txId],
  );
  const claim = r.rows[0] as { agent_id: string; agent_key_hash: string } | undefined;
  return {
    tx_id: txId,
    // A missing claim row is unreachable (the escalation implies a pipeline run)
    // but must not crash the resume; NULL owner ⇒ owned by nobody, never by
    // a guessable id.
    agent: claim === undefined
      ? { agent_id: "", key_hash: "0".repeat(64) }
      : { agent_id: claim.agent_id, key_hash: claim.agent_key_hash },
    buyer_request: { items: [], channel: "AGENT" },
    customer_note_raw: "",
    merchant_id: "meeras-cakes",
  };
}

function stubTransportNeverCalled(): NegotiationTransport {
  return {
    execute: () => Promise.reject(new Error("negotiation cannot run in the resume path")),
  };
}

async function setStage(db: PgPool, txId: string, stage: string): Promise<void> {
  await db.query(`UPDATE proposal_txs SET stage=$2, updated_at=now() WHERE tx_id=$1`, [txId, stage]);
}

async function dbUpdate(
  db: PgPool,
  txId: string,
  stage: string,
  outcome: Record<string, unknown>,
  finished: boolean,
): Promise<void> {
  await db.query(
    `UPDATE proposal_txs SET stage=$2, outcome_json=$3, updated_at=now(),
            finished_at = CASE WHEN $4 THEN now() ELSE finished_at END
      WHERE tx_id=$1`,
    [txId, stage, JSON.stringify(outcome), finished],
  );
}

async function dbFinish(
  db: PgPool,
  txId: string,
  stage: string,
  outcome: Record<string, unknown>,
): Promise<void> {
  await dbUpdate(db, txId, stage, outcome, true);
}

function terminalOutcomeJson(t: RunTerminal): Record<string, unknown> {
  switch (t.kind) {
    case "AWAITING_PAYMENT":
      return {
        outcome: "APPROVED",
        payment_status: "AWAITING_WEBHOOK",
        rzp_order_id: t.rzp_order_id,
      };
    case "DECLINED":
      return { outcome: "DECLINED", decline_reasons: [] };
    case "ESCALATED":
      return { outcome: "ESCALATED", approval_id: t.approval_id, expires_at: t.expires_at };
    case "FAILED":
      return { outcome: "FAILED", failure: { reason: t.reason, retryable: t.retryable } };
  }
}

function degradedCause(f: "REFUSAL" | "MAX_TOKENS" | "PARSE_FAILED" | "TRANSPORT_ERROR" | null): string {
  switch (f) {
    case "PARSE_FAILED":
      return "SCHEMA_PARSE_FAIL";
    case null:
      return "LLM_ERROR";
    default:
      return "LLM_ERROR";
  }
}

function emptyVelocity(agentId: string, nowIso: string): AgentVelocitySnapshot {
  const win = (seconds: 3600 | 86400) => ({
    window_seconds: seconds,
    window_end_iso: nowIso,
    request_count: 0,
    approved_value_paise: 0,
  });
  return {
    status: "AVAILABLE",
    agent_identity_id: agentId,
    hour_window: win(3600),
    day_window: win(86400),
    prior_escalations_24h: 0,
    prior_declines_24h: 0,
    injection_flags_24h: 0,
    source: "redis_sliding_window_v1",
  };
}

function escalateReason(gate: GatekeeperResult): {
  reason: "HIGH_CART_VALUE" | "ESCALATION_BAND_SOFT_EDGE" | "VELOCITY_SOFT_BAND" | "MANUAL_REVIEW_FLAG";
  band_context: Record<string, unknown>;
} {
  const first = gate.escalations[0];
  const code = first?.reason_code ?? "";
  if (code.includes("BAND") || code.includes("SOFT_EDGE")) {
    return {
      reason: "ESCALATION_BAND_SOFT_EDGE",
      band_context: { observed: first?.human_message ?? "", threshold: "escalation band edge" },
    };
  }
  if (code.includes("VELOCITY")) {
    return {
      reason: "VELOCITY_SOFT_BAND",
      band_context: { observed: first?.human_message ?? "", threshold: "velocity soft band" },
    };
  }
  return {
    reason: "HIGH_CART_VALUE",
    band_context: { observed: first?.human_message ?? "cart value above cap", threshold: "max_cart_value_paise" },
  };
}

/**
 * Mint the SettleableProposal from the GATEKEEPER's recomputed totals (never
 * AI numbers). Lines carry the discounted UNIT price with the paise remainder
 * distributed deterministically (first-line-first) so Σ qty×unit equals the
 * recomputed net EXACTLY — settlement moves precisely the approved amount.
 */
export function mintSettleable(args: {
  txId: string;
  proposal: NegotiationProposal;
  gt: GroundTruthSnapshot;
  gate: GatekeeperResult;
  approvalSource: "GATEKEEPER_AUTO" | "HUMAN_ESCALATION";
  approvalToken?: string | undefined;
}): SettleableProposal {
  const perLine = args.gate.recomputed.per_line;
  const baseUnits = perLine.map((pl) => {
    const q = pl.quantity;
    const base = Math.floor(pl.net_paise / q);
    return { sku_id: pl.sku_id, qty: q, base, rem: pl.net_paise - base * q };
  });
  let leftover = baseUnits.reduce((s, u) => s + u.rem, 0);
  const units = baseUnits.map((u) => {
    const add = Math.min(u.qty, leftover);
    leftover -= add;
    return { ...u, unit_price_paise: u.base + add };
  });
  if (leftover !== 0) {
    throw new Error(`mintSettleable: ${leftover} paise undistributed (programmer bug)`);
  }

  const lines = units.map((u) => {
    const item = args.gt.items.find((it) => it.sku_id === u.sku_id);
    if (item === undefined) throw new Error(`mintSettleable: unresolved sku ${u.sku_id}`);
    return { sku: u.sku_id, qty: u.qty, unit_price_paise: u.unit_price_paise };
  });
  const total = args.gate.recomputed.net_paise;
  const sum = lines.reduce((s, l) => s + l.unit_price_paise * l.qty, 0);
  if (sum !== total) {
    throw new Error(`mintSettleable: line sum ${sum} != net ${total} (programmer bug)`);
  }

  const draft = {
    tx_id: args.txId,
    proposal_id: `prop_${createHash("sha256").update(canonicalJson(args.proposal)).digest("hex").slice(0, 16)}`,
    proposal_sha256: "",
    lines,
    total_amount_paise: total,
    currency: "INR" as const,
    gatekeeper: {
      verdict: "APPROVE" as const,
      ruleset_version: args.gate.rules_version,
      trace_digest: args.gate.input_digest,
    },
    approval_source: args.approvalSource,
    ...(args.approvalToken !== undefined ? { approval_token: args.approvalToken } : {}),
  };
  return { ...draft, proposal_sha256: sha256Hex(canonicalJson(digestView(draft))) };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Map the shared CitationAuditResult onto the SSE payload honestly. */
async function emitAuditResult(
  emitter: PipelineEmitter,
  txId: string,
  audit: CitationAuditResult,
): Promise<number> {
  return emitter.emit(txId, "citation_audit_result", {
    auditor: "DETERMINISTIC_CITATION_AUDITOR",
    verdict: audit.verdict,
    checked_claims: audit.checked_claims,
    violation_count: audit.violations.length,
    violations: audit.violations.map((v) => ({
      claim_index: v.claim_index,
      code: v.code,
      detail: v.detail,
    })),
    proposal_accepted_into_pipeline: audit.verdict !== "FAILED",
  }, systemActor("citation-auditor", "CITATION_AUDITOR"));
}
