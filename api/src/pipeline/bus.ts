/**
 * In-process SSE hub (frontend-events.md §1). Channels: `tx:<txId>` for the
 * per-transaction trace and `admin` for the global bus. The HTTP route layer
 * (M8) subscribes BEFORE querying history and drains what it buffered — the
 * classic subscribe-first-then-replay-then-drain race fix lives THERE; this
 * module only guarantees publish ordering per channel = audit seq order.
 *
 * Frame formatting is here too as pure string functions so the exact wire
 * shape is unit-testable without opening a socket:
 *   durable  → "id: <seq>\nevent: <name>\ndata: <json>\n\n"  (id == seq)
 *   ephemeral→ NO id line — must never perturb Last-Event-ID resume position.
 */
import type { AnyEnvelope, EphemeralEventName } from "@growthagent/shared";

export const ADMIN_CHANNEL = "admin";
export const txChannel = (txId: string): string => `tx:${txId}`;

export type BusFrame =
  | { readonly kind: "durable"; readonly envelope: AnyEnvelope }
  | { readonly kind: "ephemeral"; readonly event: EphemeralEventName; readonly payload: unknown };

type Subscriber = (f: BusFrame) => void;

export class TraceBus {
  private readonly subs = new Map<string, Set<Subscriber>>();

  /** Returns an unsubscribe handle. */
  subscribe(channel: string, fn: Subscriber): () => void {
    let set = this.subs.get(channel);
    if (!set) {
      set = new Set();
      this.subs.set(channel, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  publishDurable(channel: string, envelope: AnyEnvelope): void {
    this.publish(channel, { kind: "durable", envelope });
  }

  publishEphemeral(
    channel: string,
    event: EphemeralEventName,
    payload: unknown,
  ): void {
    this.publish(channel, { kind: "ephemeral", event, payload });
  }

  private publish(channel: string, frame: BusFrame): void {
    const set = this.subs.get(channel);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(frame);
      } catch {
        // A broken subscriber must never take down the publisher.
      }
    }
  }

  subscriberCount(channel: string): number {
    return this.subs.get(channel)?.size ?? 0;
  }
}

/** One durable SSE frame: id line present, blank line terminates. */
export function formatDurableFrame(envelope: AnyEnvelope): string {
  return `id: ${envelope.seq}\nevent: ${envelope.event}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** Ephemeral frames carry NO id: line (SSE spec: lastEventId never moves). */
export function formatEphemeralFrame(
  event: EphemeralEventName,
  payload: unknown,
): string {
  return `event: ${event}\ndata: ${JSON.stringify({ event, payload })}\n\n`;
}

/** Heartbeat as an SSE COMMENT line in the api-contract flavor (`: ping`) —
 *  comments are invisible to EventSource by construction. The typed
 *  heartbeat event still exists for the FE taxonomy via ephemeral frames. */
export function formatCommentPing(): string {
  return ": ping\n\n";
}

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};
