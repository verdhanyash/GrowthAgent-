/**
 * SSE payload contracts — the events completed from PlaceholderZ to real
 * schemas (M9 Phase A). Every sample below mirrors a real emit site in
 * api/src/pipeline/orchestrator.ts. The point is to PROVE validate-on-write
 * (emitter calls EVENT_SCHEMAS[event].parse and throws on failure) accepts the
 * pipeline's actual payloads — without needing the integration Postgres DB.
 */
import { describe, expect, it } from "vitest";
import { EVENT_SCHEMAS, EVENT_NAMES, parseFrame, type EventName } from "../index.js";

/** One representative, orchestrator-accurate payload per completed event. */
const SAMPLES: Partial<Record<EventName, unknown>> = {
  evidence_pack_built: {
    pack: {
      pack_hash: "a".repeat(64),
      built_at: "2026-08-31T10:00:00.000Z",
      sim_today: "2026-08-31",
      merchant_id: "meera.saree.house",
      entries: [
        {
          id: "E001",
          kind: "PRICE",
          sku: "SKU-1",
          payload: { list_price_paise: 250000 },
          source_table: "catalog",
          computed_at: "2026-08-31T10:00:00.000Z",
        },
      ],
    },
  },
  campaign_priority_injected: {
    priority_set_id: "active",
    generated_at: "2026-08-31T10:00:01.000Z",
    degraded: false,
    priorities: [
      {
        priority_id: "PRI-001",
        action: "CLEAR_NEAR_EXPIRY",
        target_skus: ["SKU-1", "SKU-2"],
        weight: 80,
        rationale_plain_language: "Clear near-expiry stock first.",
      },
    ],
  },
  proposal_ready: {
    proposal: {
      proposed_items: [{ sku: "SKU-1", qty: 1 }],
      bundle_discount_pct: 8,
      claims: [{ claim: "pairs well", evidence_ids: ["E001"] }],
      customer_pitch: "This blouse completes the saree.",
      upsell_reasoning_summary: "Attach-rate 62%.",
      used_campaign_priority: true,
      campaign_priority_ids: ["PRI-001"],
    },
    generator: "NEGOTIATION_LLM_V3",
    is_fallback: false,
    degraded: false,
    latency_ms: 1420,
  },
  citation_audit_result: {
    auditor: "DETERMINISTIC_CITATION_AUDITOR",
    verdict: "CLEAN",
    checked_claims: 2,
    violation_count: 0,
    violations: [],
    proposal_accepted_into_pipeline: true,
  },
  settlement_step: {
    step: "RAZORPAY_ORDER_CREATE",
    status: "SUCCEEDED",
    attempt: 1,
    provider_mode: "MOCK",
    amount_paise: 250000,
    currency: "INR",
    razorpay_order_id: "order_MockXYZ",
  },
  webhook_received: {
    provider: "razorpay",
    event_type: "payment.captured",
    razorpay_order_id: "order_MockXYZ",
    status: "captured",
    verified: true,
  },
  escalation_created: {
    escalation_id: "esc_01J",
    reason_codes: ["GK-DISCOUNT-CAP"],
    expires_at: "2026-08-31T10:30:00.000Z",
    proposed_cart: {
      lines: [{ sku: "SKU-1", qty: 1, unit_price_paise: 250000 }],
      subtotal_paise: 250000,
      discount_percent_bps: 0,
      discount_paise: 0,
      total_paise: 250000,
    },
    rule_trace_ref: { run_id: "run_1", trace_digest: "b".repeat(64) },
  },
  escalation_approved: {
    escalation_id: "esc_01J",
    decision: "APPROVED",
    decided_by: "ops.reviewer",
    decided_at: "2026-08-31T10:05:00.000Z",
    note: "Within blended margin floor.",
  },
  escalation_rejected: {
    escalation_id: "esc_01J",
    decision: "REJECTED",
    decided_by: "ops.reviewer",
    decided_at: "2026-08-31T10:06:00.000Z",
  },
  explanation_narrative: {
    audience: "BUYER_EXPLAINER",
    title: "Approved",
    body_md: "The bundle cleared all 16 gatekeeper rules.",
    non_authoritative: true,
    grounded_on_events: [1, 12, 40],
    degraded: false,
  },
  degraded: {
    stage: "NEGOTIATION",
    cause: "LLM_ERROR",
    fallback_engaged: "RULE_BASED_FALLBACK_BUNDLE",
    chaos_forced: false,
  },
};

describe("completed SSE payload schemas (validate-on-write)", () => {
  for (const [event, sample] of Object.entries(SAMPLES) as [EventName, unknown][]) {
    it(`EVENT_SCHEMAS["${event}"].parse accepts the orchestrator payload`, () => {
      expect(() => EVENT_SCHEMAS[event].parse(sample)).not.toThrow();
    });

    it(`parseFrame round-trips "${event}"`, () => {
      const r = parseFrame(event, JSON.stringify(sample));
      expect(r.ok).toBe(true);
    });
  }

  it("every event name has a schema (none left as a bare passthrough placeholder)", () => {
    for (const name of EVENT_NAMES) {
      expect(EVENT_SCHEMAS[name]).toBeDefined();
    }
  });

  it("tolerates additive/unknown top-level keys (no .strict — pipeline never breaks on a new field)", () => {
    const withExtra = { ...(SAMPLES.degraded as object), future_field: "ok" };
    expect(() => EVENT_SCHEMAS.degraded.parse(withExtra)).not.toThrow();
  });

  it("still rejects a structurally wrong payload", () => {
    const bad = parseFrame("settlement_step", JSON.stringify({ step: "X", status: "OK", attempt: -1 }));
    expect(bad.ok).toBe(false); // attempt must be a positive int
  });

  it("rejects an unknown event name", () => {
    expect(parseFrame("not_a_real_event", "{}").ok).toBe(false);
  });
});
