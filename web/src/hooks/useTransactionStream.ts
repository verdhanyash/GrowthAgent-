/**
 * web/src/hooks/useTransactionStream.ts — owns the EventSource lifecycle for
 * one transaction and folds every frame through the pure `traceReducer`.
 *
 * Why we drive reconnection ourselves instead of leaning on the native
 * EventSource auto-reconnect: the stream is authorized by a 60s single-use
 * ticket in the URL query (browsers can't set headers on EventSource). Native
 * reconnect would replay the SAME url with an expired ticket and 401-loop. So
 * on any error we close, mint a FRESH ticket, and reconnect with
 * `?lastEventId=<headSeq>` so the server replays only what we missed (durable
 * events are deduped by seq in the reducer regardless).
 *
 * `active` is controlled by the caller (flipped false once the poll reports a
 * TERMINAL outcome) — that, plus a stream-derived terminal heuristic, stops the
 * reconnect loop cleanly when the tx is done.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { EVENT_NAMES } from "@growthagent/shared";
import { streamUrl } from "../lib/api.js";
import {
  initialTraceState,
  parseWireFrame,
  streamLooksTerminal,
  traceReducer,
  type TraceState,
} from "./traceReducer.js";

export type ConnStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

export interface UseTransactionStreamOptions {
  active: boolean;
  mintTicket: (txId: string) => Promise<string>;
  makeUrl?: (txId: string, ticket: string, lastEventId: number) => string;
  EventSourceCtor?: typeof EventSource;
  maxReconnects?: number;
}

export interface UseTransactionStreamResult {
  state: TraceState;
  status: ConnStatus;
  reconnects: number;
  error: string | null;
}

const BACKOFF_MS = [300, 800, 1500, 3000, 5000];

export function useTransactionStream(
  txId: string | null,
  opts: UseTransactionStreamOptions,
): UseTransactionStreamResult {
  const { active, mintTicket } = opts;
  const makeUrl = opts.makeUrl ?? streamUrl;
  const ESCtor = opts.EventSourceCtor ?? (typeof EventSource !== "undefined" ? EventSource : undefined);
  const maxReconnects = opts.maxReconnects ?? 6;

  const [state, dispatch] = useReducer(traceReducer, txId, initialTraceState);
  const [status, setStatus] = useState<ConnStatus>("idle");
  const [reconnects, setReconnects] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const headSeqRef = useRef(0);
  const terminalRef = useRef(false);

  useEffect(() => {
    // headSeq must be readable by (re)connects without re-subscribing the effect.
    headSeqRef.current = state.headSeq;
    if (streamLooksTerminal(state)) terminalRef.current = true;
  }, [state]);

  useEffect(() => {
    if (txId === null) {
      setStatus("idle");
      return;
    }
    if (ESCtor === undefined) {
      setError("EventSource unavailable in this environment");
      setStatus("error");
      return;
    }
    dispatch({ type: "reset", txId });
    headSeqRef.current = 0;
    terminalRef.current = false;
    setReconnects(0);
    setError(null);

    if (!active) {
      setStatus("closed");
      return;
    }

    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    const onFrame = (e: MessageEvent): void => {
      const parsed = parseWireFrame(e.type, typeof e.data === "string" ? e.data : "");
      if (parsed.kind === "durable") {
        headSeqRef.current = Math.max(headSeqRef.current, parsed.envelope.seq);
        dispatch({ type: "durable", envelope: parsed.envelope });
      } else if (parsed.kind === "ephemeral") {
        dispatch({ type: "ephemeral", event: parsed.event, payload: parsed.payload });
      }
    };

    const scheduleReconnect = (): void => {
      if (disposed || terminalRef.current) {
        setStatus("closed");
        return;
      }
      if (attempt >= maxReconnects) {
        setStatus("error");
        setError("stream lost — max reconnect attempts reached");
        return;
      }
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
      attempt += 1;
      setReconnects(attempt);
      setStatus("reconnecting");
      timer = setTimeout(() => void connect(), delay);
    };

    const connect = async (): Promise<void> => {
      if (disposed || terminalRef.current) return;
      setStatus((s) => (s === "reconnecting" ? s : "connecting"));
      let ticket: string;
      try {
        ticket = await mintTicket(txId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "failed to mint stream ticket");
        scheduleReconnect();
        return;
      }
      if (disposed) return;
      const url = makeUrl(txId, ticket, headSeqRef.current);
      const source = new ESCtor(url, { withCredentials: false });
      es = source;
      source.onopen = (): void => {
        attempt = 0;
        setStatus("open");
        setError(null);
      };
      for (const name of EVENT_NAMES) source.addEventListener(name, onFrame as EventListener);
      source.onmessage = onFrame;
      source.onerror = (): void => {
        source.close();
        if (es === source) es = null;
        scheduleReconnect();
      };
    };

    void connect();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (es) es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txId, active]);

  return { state, status, reconnects, error };
}
