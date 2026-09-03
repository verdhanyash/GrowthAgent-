/**
 * useTransactionStream lifecycle tests. We inject a FakeEventSource (the hook
 * takes `EventSourceCtor`) so we can drive open/message/error frames by hand
 * under jsdom — no real network, no real SSE. The reducer projection itself is
 * covered separately in traceReducer.spec.ts; here we assert the *connection*
 * behaviour: ticket mint → connect, frame dispatch, terminal-stops-reconnect,
 * error-triggers-fresh-ticket-reconnect, and bounded backoff give-up.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENT_NAMES } from "@growthagent/shared";
import { useTransactionStream } from "./useTransactionStream.js";

/* A hand-drivable EventSource stand-in. Instances register themselves so the
 * test can grab the live one and fire events at it. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, Set<EventListener>>();

  constructor(
    readonly url: string,
    readonly init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  close(): void {
    this.closed = true;
  }

  /* --- test drivers --- */
  emitOpen(): void {
    this.onopen?.(new Event("open"));
  }

  emit(eventName: string, data: string): void {
    const ev = new MessageEvent(eventName, { data });
    // dispatch to the named listener (durable/ephemeral both arrive via
    // addEventListener in the hook); fall back to onmessage.
    const set = this.listeners.get(eventName);
    if (set && set.size > 0) {
      for (const fn of set) fn(ev);
    } else {
      this.onmessage?.(ev);
    }
  }

  emitError(): void {
    this.onerror?.(new Event("error"));
  }

  static last(): FakeEventSource {
    const l = FakeEventSource.instances.at(-1);
    if (!l) throw new Error("no FakeEventSource constructed");
    return l;
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}

const ESCtor = FakeEventSource as unknown as typeof EventSource;

function durableFrame(seq: number, event: string, payload: unknown): string {
  return JSON.stringify({
    seq,
    prev_hash: null,
    hash: "h".repeat(64),
    tx_id: "tx_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ts: "2026-08-31T10:00:00.000Z",
    event,
    actor: { agent_id: "sys", kind: "SYSTEM", key_hash: "k".repeat(64) },
    rules_version: 1,
    payload,
  });
}

afterEach(() => {
  FakeEventSource.reset();
  vi.restoreAllMocks();
});

describe("useTransactionStream", () => {
  it("stays idle for a null txId and never mints a ticket", () => {
    const mintTicket = vi.fn(async () => "T");
    const { result } = renderHook(() =>
      useTransactionStream(null, { active: true, mintTicket, EventSourceCtor: ESCtor }),
    );
    expect(result.current.status).toBe("idle");
    expect(mintTicket).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("is closed (no socket) when active is false", async () => {
    const mintTicket = vi.fn(async () => "T");
    const { result } = renderHook(() =>
      useTransactionStream("tx_1", { active: false, mintTicket, EventSourceCtor: ESCtor }),
    );
    await waitFor(() => expect(result.current.status).toBe("closed"));
    expect(mintTicket).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("mints a ticket, connects, opens, and folds durable frames into state", async () => {
    const mintTicket = vi.fn(async () => "TICKET-1");
    const makeUrl = vi.fn(
      (txId: string, ticket: string, lastEventId: number) => `sse://${txId}?t=${ticket}&l=${lastEventId}`,
    );
    const { result } = renderHook(() =>
      useTransactionStream("tx_1", { active: true, mintTicket, makeUrl, EventSourceCtor: ESCtor }),
    );

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(mintTicket).toHaveBeenCalledWith("tx_1");
    expect(makeUrl).toHaveBeenCalledWith("tx_1", "TICKET-1", 0);

    const es = FakeEventSource.last();
    act(() => es.emitOpen());
    await waitFor(() => expect(result.current.status).toBe("open"));

    act(() => es.emit("stage_started", durableFrame(1, "stage_started", { stage: "INTAKE", attempt: 1 })));
    await waitFor(() => expect(result.current.state.eventCount).toBe(1));
    expect(result.current.state.headSeq).toBe(1);
    expect(result.current.state.stages).toHaveLength(1);
  });

  it("replays a finished transaction's history and then stops, without retrying", async () => {
    // The common case for the trace screen: the run is long over, so the only
    // thing the socket is for is the durable replay the SSE route performs on
    // connect. Once the server closes it, there is nothing to reconnect to.
    const mintTicket = vi.fn(async () => "T");
    const { result } = renderHook(() =>
      useTransactionStream("tx_1", {
        active: true,
        alreadyTerminal: true,
        mintTicket,
        EventSourceCtor: ESCtor,
      }),
    );

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.last();
    act(() => es.emitOpen());
    await waitFor(() => expect(result.current.status).toBe("open"));

    // Replayed history lands in state exactly like live frames do.
    act(() => {
      es.emit("stage_started", durableFrame(1, "stage_started", { stage: "INTAKE", attempt: 1 }));
      es.emit("stage_completed", durableFrame(2, "stage_completed", { stage: "INTAKE", outcome: "OK", duration_ms: 8 }));
    });
    await waitFor(() => expect(result.current.state.eventCount).toBe(2));
    expect(result.current.state.stages).toHaveLength(1);

    // Server closes after the replay: settle, do not re-dial, do not report an
    // error the operator would have to interpret.
    act(() => es.emitError());
    await waitFor(() => expect(result.current.status).toBe("closed"));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(mintTicket).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("registers a listener for every shared EVENT_NAMES entry", async () => {
    const mintTicket = vi.fn(async () => "T");
    renderHook(() => useTransactionStream("tx_1", { active: true, mintTicket, EventSourceCtor: ESCtor }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.last();
    for (const name of EVENT_NAMES) expect(es.listeners.has(name)).toBe(true);
  });

  it("does NOT reconnect after a terminal stream (narrative seen), it closes", async () => {
    const mintTicket = vi.fn(async () => "T");
    const { result } = renderHook(() =>
      useTransactionStream("tx_1", { active: true, mintTicket, EventSourceCtor: ESCtor }),
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.last();
    act(() => es.emitOpen());

    act(() =>
      es.emit(
        "explanation_narrative",
        durableFrame(1, "explanation_narrative", {
          audience: "BUYER_EXPLAINER",
          title: "Done",
          body_md: "ok",
          non_authoritative: true,
          grounded_on_events: [1],
          degraded: false,
        }),
      ),
    );
    await waitFor(() => expect(result.current.state.narrative).not.toBeNull());

    // Server drops the connection after the terminal event; the hook must NOT
    // mint a second ticket — it recognises the stream is terminal and closes.
    act(() => es.emitError());
    await waitFor(() => expect(result.current.status).toBe("closed"));
    expect(mintTicket).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("reconnects with a FRESH ticket and the resume position after a mid-stream error", async () => {
    let issued = 0;
    const mintTicket = vi.fn(async () => `T${++issued}`);
    const makeUrl = vi.fn(
      (txId: string, ticket: string, lastEventId: number) => `sse://${txId}?t=${ticket}&l=${lastEventId}`,
    );
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useTransactionStream("tx_1", { active: true, mintTicket, makeUrl, EventSourceCtor: ESCtor }),
      );
      await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
      const es1 = FakeEventSource.last();
      act(() => es1.emitOpen());
      act(() => es1.emit("stage_started", durableFrame(7, "stage_started", { stage: "INTAKE", attempt: 1 })));
      await vi.waitFor(() => expect(result.current.state.headSeq).toBe(7));

      // Connection drops mid-stream (non-terminal) → schedule reconnect.
      act(() => es1.emitError());
      expect(result.current.status).toBe("reconnecting");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400); // first backoff = 300ms
      });

      await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
      // fresh ticket, resume from headSeq=7
      expect(makeUrl).toHaveBeenLastCalledWith("tx_1", "T2", 7);
      expect(mintTicket).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxReconnects and surfaces an error", async () => {
    const mintTicket = vi.fn(async () => "T");
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useTransactionStream("tx_1", {
          active: true,
          mintTicket,
          EventSourceCtor: ESCtor,
          maxReconnects: 2,
        }),
      );
      await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

      // Fail every socket immediately as it opens; drain the backoff schedule.
      for (let i = 0; i < 5; i++) {
        const es = FakeEventSource.last();
        act(() => es.emitError());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6000);
        });
      }
      await vi.waitFor(() => expect(result.current.status).toBe("error"));
      expect(result.current.error).toMatch(/max reconnect/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
