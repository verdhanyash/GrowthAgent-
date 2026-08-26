/** TraceBus + SSE frame formatting: the wire contract, without a socket. */
import { describe, expect, it } from "vitest";
import {
  ADMIN_CHANNEL,
  SSE_HEADERS,
  TraceBus,
  formatCommentPing,
  formatDurableFrame,
  formatEphemeralFrame,
  txChannel,
} from "../bus.js";
import type { AnyEnvelope } from "@growthagent/shared";

const envelope = (seq: number) =>
  ({
    seq,
    prev_hash: null,
    hash: "a".repeat(64),
    tx_id: "tx_demo",
    ts: "2026-08-26T10:00:00.000Z",
    event: "stage_started",
    actor: { agent_id: "pipeline", kind: "PIPELINE", key_hash: "b".repeat(64) },
    rules_version: 3,
    payload: { stage: "INTAKE", attempt: 1 },
  }) as unknown as AnyEnvelope;

describe("TraceBus", () => {
  it("delivers durable frames to per-tx subscribers only", () => {
    const bus = new TraceBus();
    const gotTx: string[] = [];
    const gotAdmin: string[] = [];
    bus.subscribe(txChannel("tx_demo"), (f) => {
      if (f.kind === "durable") gotTx.push(f.envelope.event);
    });
    bus.subscribe(ADMIN_CHANNEL, (f) => {
      if (f.kind === "durable") gotAdmin.push(f.envelope.event);
    });
    bus.publishDurable(txChannel("tx_demo"), envelope(1));
    expect(gotTx).toEqual(["stage_started"]);
    expect(gotAdmin).toEqual([]);
  });

  it("unsubscribe stops delivery and decrements the count", () => {
    const bus = new TraceBus();
    let n = 0;
    const off = bus.subscribe(txChannel("t"), () => void (n += 1));
    expect(bus.subscriberCount(txChannel("t"))).toBe(1);
    off();
    bus.publishDurable(txChannel("t"), envelope(2));
    expect(n).toBe(0);
    expect(bus.subscriberCount(txChannel("t"))).toBe(0);
  });

  it("a throwing subscriber never breaks the publisher or its peers", () => {
    const bus = new TraceBus();
    const got: number[] = [];
    bus.subscribe(txChannel("t"), () => {
      throw new Error("broken consumer");
    });
    bus.subscribe(txChannel("t"), (f) => {
      if (f.kind === "durable") got.push(f.envelope.seq);
    });
    expect(() => bus.publishDurable(txChannel("t"), envelope(7))).not.toThrow();
    expect(got).toEqual([7]);
  });

  it("ephemeral frames ride the same channel without touching durability", () => {
    const bus = new TraceBus();
    const got: string[] = [];
    bus.subscribe(txChannel("t"), (f) => {
      if (f.kind === "ephemeral") got.push(`${f.event}:${JSON.stringify(f.payload)}`);
    });
    bus.publishEphemeral(txChannel("t"), "negotiation_token", { t: "Hel" });
    expect(got).toEqual(['negotiation_token:{"t":"Hel"}']);
  });
});

describe("SSE frame formatting", () => {
  it("durable frames carry an id line (seq) so Last-Event-ID resume works", () => {
    const frame = formatDurableFrame(envelope(42));
    expect(frame).toMatch(/^id: 42\nevent: stage_started\ndata: \{.*\}\n\n$/s);
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))!;
    expect(JSON.parse(dataLine.slice(6))).toMatchObject({ seq: 42, event: "stage_started" });
  });

  it("ephemeral frames carry NO id line — resume position never moves", () => {
    const frame = formatEphemeralFrame("negotiation_token", { t: "x" });
    expect(frame.startsWith("id:")).toBe(false);
    expect(frame).toBe(`event: negotiation_token\ndata: ${JSON.stringify({ event: "negotiation_token", payload: { t: "x" } })}\n\n`);
  });

  it("heartbeat is a comment line invisible to EventSource", () => {
    expect(formatCommentPing()).toBe(": ping\n\n");
  });

  it("exposes the event-stream headers", () => {
    expect(SSE_HEADERS["Content-Type"]).toContain("text/event-stream");
    expect(SSE_HEADERS["Cache-Control"]).toContain("no-cache");
  });
});
