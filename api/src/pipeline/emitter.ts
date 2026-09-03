/**
 * TraceEmitter (frontend-events.md §1.6 handoff contract). Durable events:
 * validate payload against the shared taxonomy ON WRITE, persist through the
 * hash chain, publish the envelope on the bus (per-tx channel; escalation and
 * rules events ALSO on the admin channel). Ephemeral events: bus only — no
 * DB row, no seq, no SSE id.
 *
 * The hard interface rule: a schema-invalid payload throws HERE, at the
 * emitter — a mismatch fails loudly instead of rendering garbage downstream.
 */
import {
  EVENT_SCHEMAS,
  type AnyEnvelope,
  type EventName,
  type EventPayloadMap,
  type EphemeralEventName,
} from "@growthagent/shared";
import { createHash } from "node:crypto";
import type { AuditSink, AuditEvent } from "../audit/writer.js";
import type { AuditChain} from "./audit-chain.js";
import { type AuditRow, type ChainActor } from "./audit-chain.js";
import type { TraceBus} from "./bus.js";
import { ADMIN_CHANNEL, txChannel } from "./bus.js";

/** Events the RulesScreen inbox / admin stream care about (§1.5 admin-only
 *  note + escalation lifecycle). */
const ADMIN_EVENTS: ReadonlySet<string> = new Set([
  "escalation_created",
  "escalation_approved",
  "escalation_rejected",
  "rules_version_updated",
]);

export class PipelineEmitter {
  constructor(
    private readonly chain: AuditChain,
    private readonly bus: TraceBus,
    private readonly rulesVersion: number | (() => number),
  ) {}

  private version(): number {
    return typeof this.rulesVersion === "function" ? this.rulesVersion() : this.rulesVersion;
  }

  /** Durable: persist + publish; resolves with the assigned seq. */
  async emit<K extends EventName>(
    txId: string,
    event: K,
    payload: EventPayloadMap[K],
    actor: ChainActor,
  ): Promise<number> {
    // Validate-on-write (PlaceholderZ payloads pass through until their owning
    // module spec refines them — the envelope itself is always exact).
    const checked = (
      EVENT_SCHEMAS as Record<string, { parse(p: unknown): unknown } | undefined>
    )[event];
    if (checked) checked.parse(payload);

    const row = await this.chain.append({
      tx_id: txId,
      ts: new Date().toISOString(),
      actor,
      rules_version: this.version(),
      event,
      payload: payload as Readonly<Record<string, unknown>>,
    });
    const envelope = rowToEnvelope(row);
    this.bus.publishDurable(txChannel(txId), envelope);
    if (ADMIN_EVENTS.has(event)) this.bus.publishDurable(ADMIN_CHANNEL, envelope);
    return row.seq;
  }

  /** Ephemeral: no DB, no seq, no id line — never perturbs resume. */
  emitEphemeral(
    txId: string,
    event: EphemeralEventName,
    payload: unknown,
  ): void {
    this.bus.publishEphemeral(txChannel(txId), event, payload);
  }
}

export function rowToEnvelope(row: AuditRow): AnyEnvelope {
  return {
    seq: row.seq,
    prev_hash: row.prev_hash,
    hash: row.hash,
    tx_id: row.tx_id as never, // '-' global rows are not TxIds; cast at the seam
    ts: row.ts,
    event: row.event as never,
    actor: row.actor as never,
    rules_version: row.rules_version,
    payload: row.payload as never,
  } as AnyEnvelope;
}

/* ------------------- settlement legacy-sink bridge ---------------------- */

/** Deterministic pseudo key-hash for actors without an API key: sha256 of the
 *  actor string, clearly namespaced so it can never collide with a real one. */
export function systemActor(actorId: string, kind: string): ChainActor {
  return {
    agent_id: actorId,
    kind,
    key_hash: createHash("sha256").update(`actor:${actorId}`).digest("hex"),
  };
}

function guessKind(actor: string): string {
  if (actor.startsWith("settlement") || actor.includes("rzp")) return "SETTLEMENT";
  if (actor.startsWith("gatekeeper")) return "GATEKEEPER";
  if (actor.startsWith("negotiation")) return "NEGOTIATION";
  if (actor.startsWith("campaign")) return "CAMPAIGN";
  if (actor.startsWith("explainer") || actor.startsWith("narrator")) return "EXPLAINER";
  return "SYSTEM";
}

/**
 * Adapts settlement's synchronous appendAudit seam onto the chained sink:
 * every M6 audit event joins THE one hash chain (single trail for the whole
 * demo), fire-and-forget with logged failures — appendAudit has no async
 * contract and callers must not block on persistence.
 */
export class ChainedAuditSink implements AuditSink {
  constructor(
    private readonly chain: AuditChain,
    private readonly rulesVersion: () => number,
  ) {}

  append(event: AuditEvent): void {
    void this.chain
      .append({
        tx_id: event.tx_id,
        ts: event.ts,
        actor: systemActor(event.actor, guessKind(event.actor)),
        rules_version: this.rulesVersion(),
        event: event.event,
        payload: event.payload,
      })
      .catch((err) => {
        // Never route through the sink again (it IS us): log and move on.
         
        console.error(
          `[audit-chain] persist failed for ${event.event}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
  }
}
