/**
 * web/src/hooks/traceReducer.ts — PURE projection of the SSE audit stream into
 * the view state the TraceScreen renders. No React, no DOM, no EventSource:
 * every branch is unit-testable by feeding it envelopes.
 *
 * The audit log is the source of truth; this reducer is just a fold over it.
 * Durable events are deduped by `seq` (the server may replay history on
 * reconnect); ephemeral events (negotiation_token/snapshot) carry no seq and
 * never move the resume position (`headSeq`).
 *
 * Wire framing (api/src/pipeline/bus.ts):
 *   durable   → data = the FULL AuditEnvelope JSON (id: line == seq)
 *   ephemeral → data = { event, payload }  (NO id: line)
 */
import {
  EVENT_SCHEMAS,
  type AnyEnvelope,
  type EventName,
  type EventPayloadMap,
  type StageName,
  type RuleId,
} from "@growthagent/shared";

export type StageStatus = "RUNNING" | "OK" | "DEGRADED" | "FAILED";

export interface StageView {
  stage: StageName;
  attempt: number;
  status: StageStatus;
  startedSeq: number | null;
  durationMs: number | null;
}

export interface RuleView {
  rule_id: RuleId;
  status: string;
  severity: string;
  expected: string | null;
  actual: string | null;
  human_message: string;
  reason_code: string | null;
  seq: number;
}

export interface LogRow {
  seq: number | null;
  event: EventName;
  ts: string | null;
  actor: string | null;
}

export interface NegotiationView {
  text: string;
  thinking: string;
  open: boolean;
  deltaIndex: number;
}

export interface TraceState {
  txId: string | null;
  headSeq: number;
  seen: Record<number, true>;
  stages: StageView[];
  rules: Record<string, RuleView>;
  decision: EventPayloadMap["gatekeeper_decision"] | null;
  injection: EventPayloadMap["injection_flagged"] | null;
  proposal: EventPayloadMap["proposal_ready"] | null;
  citation: EventPayloadMap["citation_audit_result"] | null;
  campaign: EventPayloadMap["campaign_priority_injected"] | null;
  evidencePack: EventPayloadMap["evidence_pack_built"]["pack"] | null;
  settlement: EventPayloadMap["settlement_step"][];
  escalationCreated: EventPayloadMap["escalation_created"] | null;
  escalationResolved: EventPayloadMap["escalation_approved"] | null;
  narrative: EventPayloadMap["explanation_narrative"] | null;
  degradations: EventPayloadMap["degraded"][];
  errors: EventPayloadMap["error"][];
  webhooks: EventPayloadMap["webhook_received"][];
  negotiation: NegotiationView;
  log: LogRow[];
  eventCount: number;
}

export function initialTraceState(txId: string | null = null): TraceState {
  return {
    txId,
    headSeq: 0,
    seen: {},
    stages: [],
    rules: {},
    decision: null,
    injection: null,
    proposal: null,
    citation: null,
    campaign: null,
    evidencePack: null,
    settlement: [],
    escalationCreated: null,
    escalationResolved: null,
    narrative: null,
    degradations: [],
    errors: [],
    webhooks: [],
    negotiation: { text: "", thinking: "", open: false, deltaIndex: -1 },
    log: [],
    eventCount: 0,
  };
}

export type TraceAction =
  | { type: "reset"; txId: string | null }
  | { type: "durable"; envelope: AnyEnvelope }
  | { type: "ephemeral"; event: EventName; payload: unknown };

/* --------------------------- wire frame parser --------------------------- */

export type ParsedFrame =
  | { kind: "durable"; envelope: AnyEnvelope; schemaOk: boolean }
  | { kind: "ephemeral"; event: EventName; payload: unknown }
  | { kind: "invalid"; reason: string };

/**
 * Parse one SSE frame's (eventName, data) into an action-ready shape. Never
 * throws — a poison frame is reported as `invalid` so the stream survives it
 * (mirrors shared/parseFrame's fail-soft contract). Durable frames carry the
 * full envelope in `data`; ephemeral frames carry `{ event, payload }`.
 */
export function parseWireFrame(eventName: string, data: string): ParsedFrame {
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return { kind: "invalid", reason: "malformed json" };
  }
  if (obj === null || typeof obj !== "object") {
    return { kind: "invalid", reason: "non-object frame" };
  }
  const rec = obj as Record<string, unknown>;

  // Durable envelope: has a numeric seq + a hash chain + inline payload.
  if (typeof rec.seq === "number" && typeof rec.event === "string" && "payload" in rec) {
    const ev = rec.event as string;
    const schema = (EVENT_SCHEMAS as Record<string, { safeParse(p: unknown): { success: boolean } } | undefined>)[ev];
    const schemaOk = schema ? schema.safeParse(rec.payload).success : false;
    return { kind: "durable", envelope: rec as unknown as AnyEnvelope, schemaOk };
  }

  // Ephemeral frame: { event, payload }, no seq.
  if (typeof rec.event === "string" && "payload" in rec) {
    return { kind: "ephemeral", event: rec.event as EventName, payload: rec.payload };
  }

  // Fallback: the browser told us the event name via addEventListener; treat
  // the whole body as the payload of that (typically ephemeral) event.
  if (typeof eventName === "string" && eventName !== "") {
    return { kind: "ephemeral", event: eventName as EventName, payload: obj };
  }
  return { kind: "invalid", reason: "unrecognized frame shape" };
}

/* ------------------------------- reducer -------------------------------- */

function markStageStarted(stages: StageView[], stage: StageName, attempt: number, seq: number): StageView[] {
  return [...stages, { stage, attempt, status: "RUNNING", startedSeq: seq, durationMs: null }];
}

function markStageCompleted(
  stages: StageView[],
  stage: StageName,
  outcome: "OK" | "DEGRADED" | "FAILED",
  durationMs: number,
): StageView[] {
  // Update the LAST still-RUNNING entry for this stage (handles retries).
  const idx = [...stages].reverse().findIndex((s) => s.stage === stage && s.status === "RUNNING");
  if (idx === -1) {
    return [...stages, { stage, attempt: 1, status: outcome, startedSeq: null, durationMs }];
  }
  const realIdx = stages.length - 1 - idx;
  const next = stages.slice();
  next[realIdx] = { ...next[realIdx]!, status: outcome, durationMs };
  return next;
}

function applyDurable(state: TraceState, env: AnyEnvelope): TraceState {
  const seq = env.seq;
  if (state.seen[seq]) return state; // dedup replayed history

  const s: TraceState = {
    ...state,
    seen: { ...state.seen, [seq]: true },
    headSeq: Math.max(state.headSeq, seq),
    eventCount: state.eventCount + 1,
    log: [...state.log, { seq, event: env.event, ts: env.ts, actor: env.actor?.kind ?? null }],
  };

  switch (env.event) {
    case "stage_started":
      s.stages = markStageStarted(s.stages, env.payload.stage, env.payload.attempt, seq);
      return s;
    case "stage_completed":
      s.stages = markStageCompleted(s.stages, env.payload.stage, env.payload.outcome, env.payload.duration_ms);
      return s;
    case "evidence_pack_built":
      s.evidencePack = env.payload.pack;
      return s;
    case "campaign_priority_injected":
      s.campaign = env.payload;
      return s;
    case "proposal_ready":
      s.proposal = env.payload;
      return s;
    case "citation_audit_result":
      s.citation = env.payload;
      return s;
    case "gatekeeper_rule_result":
      s.rules = { ...s.rules, [env.payload.rule_id]: { ...env.payload, seq } };
      return s;
    case "gatekeeper_decision":
      s.decision = env.payload;
      return s;
    case "settlement_step":
      s.settlement = [...s.settlement, env.payload];
      return s;
    case "webhook_received":
      s.webhooks = [...s.webhooks, env.payload];
      return s;
    case "escalation_created":
      s.escalationCreated = env.payload;
      return s;
    case "escalation_approved":
    case "escalation_rejected":
      s.escalationResolved = env.payload;
      return s;
    case "explanation_narrative":
      s.narrative = env.payload;
      return s;
    case "degraded":
      s.degradations = [...s.degradations, env.payload];
      return s;
    case "injection_flagged":
      s.injection = env.payload;
      return s;
    case "error":
      s.errors = [...s.errors, env.payload];
      return s;
    default:
      return s;
  }
}

function applyEphemeral(state: TraceState, event: EventName, payload: unknown): TraceState {
  if (event === "negotiation_token") {
    const p = payload as { kind?: string; text?: string; delta_index?: number };
    const text = typeof p.text === "string" ? p.text : "";
    const isThinking = p.kind === "thinking_summary";
    return {
      ...state,
      negotiation: {
        ...state.negotiation,
        text: isThinking ? state.negotiation.text : state.negotiation.text + text,
        thinking: isThinking ? state.negotiation.thinking + text : state.negotiation.thinking,
        deltaIndex: typeof p.delta_index === "number" ? p.delta_index : state.negotiation.deltaIndex,
        open: true,
      },
    };
  }
  if (event === "negotiation_snapshot") {
    const p = payload as { text_so_far?: string; thinking_so_far?: string; delta_index_so_far?: number; stream_open?: boolean };
    return {
      ...state,
      negotiation: {
        text: typeof p.text_so_far === "string" ? p.text_so_far : state.negotiation.text,
        thinking: typeof p.thinking_so_far === "string" ? p.thinking_so_far : state.negotiation.thinking,
        deltaIndex: typeof p.delta_index_so_far === "number" ? p.delta_index_so_far : state.negotiation.deltaIndex,
        open: p.stream_open ?? state.negotiation.open,
      },
    };
  }
  return state; // heartbeat + anything else: no state change
}

export function traceReducer(state: TraceState, action: TraceAction): TraceState {
  switch (action.type) {
    case "reset":
      return initialTraceState(action.txId);
    case "durable":
      return applyDurable(state, action.envelope);
    case "ephemeral":
      return applyEphemeral(state, action.event, action.payload);
  }
}

/** Terminal-ish signal derivable purely from the stream (the poll is
 *  authoritative, but this lets the UI close promptly on a clear end). */
export function streamLooksTerminal(state: TraceState): boolean {
  if (state.narrative !== null) return true;
  if (state.decision?.decision === "DECLINE") return true;
  if (state.errors.some((e) => !e.retriable)) return true;
  return false;
}
