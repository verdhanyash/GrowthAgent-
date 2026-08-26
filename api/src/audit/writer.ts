/**
 * Audit seam (M6 slice of ARCHITECTURE.md §16 `api/src/audit/`). Settlement
 * emits structured events through this ONE seam; every observable step in
 * settlement.md §16's taxonomy flows through appendAudit/auditGlobal.
 *
 * HONEST SCOPE NOTE: the hash-chained persistence layer (seq + prev_hash +
 * hash per entry, chain-verifier, replay) lands with the pipeline/audit
 * milestone. Until then the default sink buffers events in memory (tests,
 * SSE fan-out later) and mirrors them to the process logger — the EVENT
 * vocabulary is final, the CHAIN is not yet. Registered in BUILD_LOG M6.
 */

export interface AuditEvent {
  /** 'tx_…' or '-' for global/system events. */
  readonly tx_id: string;
  readonly ts: string; // ISO-8601
  readonly actor: string;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AuditSink {
  append(event: AuditEvent): void;
}

/** Bounded in-memory sink: tests assert on it, SSE hub subscribes later. */
export class MemoryAuditSink implements AuditSink {
  private readonly buf: AuditEvent[] = [];

  constructor(private readonly capacity = 5000) {}

  append(event: AuditEvent): void {
    this.buf.push(event);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  /** All events for one tx (global events excluded unless requested). */
  forTx(txId: string): readonly AuditEvent[] {
    return this.buf.filter((e) => e.tx_id === txId);
  }

  count(txId: string, event: string): number {
    return this.buf.filter((e) => e.tx_id === txId && e.event === event).length;
  }

  countGlobal(event: string): number {
    return this.buf.filter((e) => e.tx_id === "-" && e.event === event).length;
  }

  all(): readonly AuditEvent[] {
    return this.buf;
  }
}

let sink: AuditSink = new MemoryAuditSink();

export function setAuditSink(next: AuditSink): void {
  sink = next;
}

export function getAuditSink(): AuditSink {
  return sink;
}

/** Timestamping lives at the writer boundary (audit infra, not settlement's
 *  determinism-critical logic); settlement passes domain times explicitly
 *  where they matter (TTL, freshness). */
export function appendAudit(
  txId: string,
  actor: string,
  event: string,
  payload: Readonly<Record<string, unknown>> = {},
): void {
  sink.append({ tx_id: txId, ts: new Date().toISOString(), actor, event, payload });
}

export function auditGlobal(
  actor: string,
  event: string,
  payload: Readonly<Record<string, unknown>> = {},
): void {
  sink.append({
    tx_id: "-",
    ts: new Date().toISOString(),
    actor,
    event,
    payload,
  });
}
