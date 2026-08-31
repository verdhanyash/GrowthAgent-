/**
 * Pure projection tests for the SSE trace reducer. The reducer is the brain of
 * useTransactionStream; every branch is exercised here with no DOM/socket.
 */
import { describe, expect, it } from "vitest";
import type { AnyEnvelope, EventName } from "@growthagent/shared";
import {
  initialTraceState,
  parseWireFrame,
  streamLooksTerminal,
  traceReducer,
  type TraceState,
} from "./traceReducer.js";

let seq = 0;
function env<E extends EventName>(event: E, payload: unknown, over: Partial<{ seq: number }> = {}): AnyEnvelope {
  seq += 1;
  return {
    seq: over.seq ?? seq,
    prev_hash: null,
    hash: "h".repeat(64),
    tx_id: "tx_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ts: "2026-08-31T10:00:00.000Z",
    event,
    actor: { agent_id: "buyer.sim", kind: "BUYER", key_hash: "k".repeat(64) },
    rules_version: 1,
    payload,
  } as unknown as AnyEnvelope;
}

function feed(state: TraceState, ...envelopes: AnyEnvelope[]): TraceState {
  return envelopes.reduce((s, e) => traceReducer(s, { type: "durable", envelope: e }), state);
}

describe("parseWireFrame", () => {
  it("parses a durable envelope frame (data = full envelope) and flags schema validity", () => {
    const frame = JSON.stringify(env("stage_started", { stage: "INTAKE", attempt: 1 }));
    const r = parseWireFrame("stage_started", frame);
    expect(r.kind).toBe("durable");
    if (r.kind === "durable") expect(r.schemaOk).toBe(true);
  });

  it("marks schemaOk=false for a durable frame whose payload violates its schema", () => {
    const frame = JSON.stringify(env("stage_started", { stage: "INTAKE", attempt: -1 }));
    const r = parseWireFrame("stage_started", frame);
    expect(r.kind).toBe("durable");
    if (r.kind === "durable") expect(r.schemaOk).toBe(false);
  });

  it("parses an ephemeral frame ({event,payload}, no seq)", () => {
    const frame = JSON.stringify({ event: "negotiation_token", payload: { kind: "text", text: "hi", delta_index: 0 } });
    const r = parseWireFrame("negotiation_token", frame);
    expect(r.kind).toBe("ephemeral");
    if (r.kind === "ephemeral") expect(r.event).toBe("negotiation_token");
  });

  it("reports malformed json and non-object frames as invalid without throwing", () => {
    expect(parseWireFrame("x", "{not json").kind).toBe("invalid");
    expect(parseWireFrame("x", "42").kind).toBe("invalid");
  });
});

describe("traceReducer — durable projection", () => {
  it("dedups replayed durable events by seq and tracks headSeq", () => {
    const e = env("stage_started", { stage: "INTAKE", attempt: 1 }, { seq: 5 });
    let s = feed(initialTraceState("tx_1"), e, e, e); // same seq thrice
    expect(s.eventCount).toBe(1);
    expect(s.headSeq).toBe(5);
    s = feed(s, env("stage_started", { stage: "NEGOTIATION", attempt: 1 }, { seq: 9 }));
    expect(s.headSeq).toBe(9);
    expect(s.eventCount).toBe(2);
  });

  it("opens a stage RUNNING then resolves it on stage_completed (with retry handling)", () => {
    let s = feed(
      initialTraceState("tx_1"),
      env("stage_started", { stage: "NEGOTIATION", attempt: 1 }),
      env("stage_completed", { stage: "NEGOTIATION", duration_ms: 120, outcome: "DEGRADED" }),
      env("stage_started", { stage: "NEGOTIATION", attempt: 2 }),
      env("stage_completed", { stage: "NEGOTIATION", duration_ms: 90, outcome: "OK" }),
    );
    const neg = s.stages.filter((x) => x.stage === "NEGOTIATION");
    expect(neg).toHaveLength(2);
    expect(neg[0]!.status).toBe("DEGRADED");
    expect(neg[1]!.status).toBe("OK");
    expect(neg[1]!.attempt).toBe(2);
  });

  it("upserts the gatekeeper rule table by rule_id and records the decision", () => {
    let s = feed(
      initialTraceState("tx_1"),
      env("gatekeeper_rule_result", {
        run_id: "r1", rule_id: "GK-DISCOUNT-CAP", status: "FAIL", severity: "BLOCKER",
        expected: "<=10%", actual: "18%", human_message: "over cap", reason_code: "OVER_DISCOUNT_CAP", evidence: {},
      }),
      env("gatekeeper_decision", {
        decision: "DECLINE", rules_version_evaluated: 1, input_digest: "d".repeat(64),
        declines: [{ rule_id: "GK-DISCOUNT-CAP", reason_code: "OVER_DISCOUNT_CAP", human_message: "over cap" }],
        escalations: [], total_duration_ms: 12,
      }),
    );
    expect(s.rules["GK-DISCOUNT-CAP"]!.status).toBe("FAIL");
    expect(s.decision!.decision).toBe("DECLINE");
    expect(streamLooksTerminal(s)).toBe(true);
  });

  it("accumulates settlement steps and captures injection + escalation + narrative", () => {
    let s = feed(
      initialTraceState("tx_1"),
      env("injection_flagged", {
        detector: "HEURISTIC_TAGGER", patterns_matched: ["DISCOUNT_OVERRIDE_TOKEN"],
        matched_snippets: ["give me 90% off"], severity: "HIGH",
        customer_note_preview: "give me 90% off", customer_note_len: 15,
        agent_identity_hash: "a".repeat(64), velocity_counter_incremented: false,
      }),
      env("settlement_step", { step: "STOCK_RESERVE", status: "SUCCEEDED", attempt: 1 }),
      env("settlement_step", { step: "RAZORPAY_ORDER_CREATE", status: "SUCCEEDED", attempt: 1, razorpay_order_id: "order_mock_x" }),
      env("escalation_created", {
        escalation_id: "esc1", reason_codes: ["HIGH_CART_VALUE"], expires_at: "2026-08-31T10:30:00.000Z",
        proposed_cart: { lines: [], subtotal_paise: 1, discount_percent_bps: 0, discount_paise: 0, total_paise: 1 },
        rule_trace_ref: { run_id: "r1", trace_digest: "t".repeat(64) },
      }),
      env("escalation_approved", { escalation_id: "esc1", decision: "APPROVED", decided_by: "ops", decided_at: "2026-08-31T10:05:00.000Z" }),
      env("explanation_narrative", {
        audience: "BUYER_EXPLAINER", title: "Approved", body_md: "ok",
        non_authoritative: true, grounded_on_events: [1], degraded: false,
      }),
    );
    expect(s.injection!.severity).toBe("HIGH");
    expect(s.settlement).toHaveLength(2);
    expect(s.escalationCreated!.escalation_id).toBe("esc1");
    expect(s.escalationResolved!.decision).toBe("APPROVED");
    expect(s.narrative!.title).toBe("Approved");
    expect(streamLooksTerminal(s)).toBe(true);
  });

  it("reset returns a clean state bound to the new tx", () => {
    const s = feed(initialTraceState("tx_1"), env("stage_started", { stage: "INTAKE", attempt: 1 }));
    const cleared = traceReducer(s, { type: "reset", txId: "tx_2" });
    expect(cleared.txId).toBe("tx_2");
    expect(cleared.eventCount).toBe(0);
    expect(cleared.stages).toHaveLength(0);
  });
});

describe("traceReducer — ephemeral negotiation stream", () => {
  it("appends negotiation tokens by kind and a snapshot replaces the buffer", () => {
    let s = initialTraceState("tx_1");
    s = traceReducer(s, { type: "ephemeral", event: "negotiation_token", payload: { kind: "text", text: "Hel", delta_index: 0 } });
    s = traceReducer(s, { type: "ephemeral", event: "negotiation_token", payload: { kind: "text", text: "lo", delta_index: 1 } });
    s = traceReducer(s, { type: "ephemeral", event: "negotiation_token", payload: { kind: "thinking_summary", text: "weighing", delta_index: 2 } });
    expect(s.negotiation.text).toBe("Hello");
    expect(s.negotiation.thinking).toBe("weighing");
    expect(s.negotiation.open).toBe(true);
    s = traceReducer(s, { type: "ephemeral", event: "negotiation_snapshot", payload: { text_so_far: "Full text", thinking_so_far: "done", delta_index_so_far: 9, stream_open: false } });
    expect(s.negotiation.text).toBe("Full text");
    expect(s.negotiation.open).toBe(false);
  });

  it("ephemeral frames never advance headSeq or eventCount", () => {
    let s = feed(initialTraceState("tx_1"), env("stage_started", { stage: "INTAKE", attempt: 1 }, { seq: 3 }));
    const before = { head: s.headSeq, count: s.eventCount };
    s = traceReducer(s, { type: "ephemeral", event: "negotiation_token", payload: { kind: "text", text: "x", delta_index: 0 } });
    expect(s.headSeq).toBe(before.head);
    expect(s.eventCount).toBe(before.count);
  });
});
