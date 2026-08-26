/**
 * api/src/http/stream.route.ts — POST /v1/stream-tickets + the live SSE
 * GET /v1/stream/:txId (api-contract §5.3, frontend-events §1).
 *
 * Ticket route (browser prep): X-Agent-Key auth → mint a 60s ticket bound to
 * {agent_id, tx_id}. Stream route: identity resolves from `?ticket=` OR a
 * direct `X-Agent-Key` (non-browser clients skip the ticket). Ownership is
 * enforced on `proposal_idempotency` BEFORE any SSE byte is written, so a
 * foreign/unknown tx gets a normal JSON 404/401 (EventSource fires onerror)
 * rather than a half-open stream.
 *
 * Connect order is the classic race-free sequence: subscribe FIRST, then replay
 * durable history (chain.tailFor after Last-Event-ID), then drain what buffered
 * during the replay (dedup by seq), then forward live. A 15s comment ping keeps
 * proxies from idling the socket; a ~1s poll on proposal_txs.outcome_json closes
 * the stream the moment the tx goes terminal (the APPROVED transition lands
 * AFTER the last durable event, so event-driven close alone would hang).
 */
import express, { type Request, type Response, type Router } from "express";
import { StreamTicketRequestSchema, StreamTicketResponseSchema, HttpError } from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import type { AuditChain } from "../pipeline/audit-chain.js";
import type { TraceBus } from "../pipeline/bus.js";
import { txChannel, formatDurableFrame, formatEphemeralFrame, formatCommentPing, SSE_HEADERS } from "../pipeline/bus.js";
import { rowToEnvelope } from "../pipeline/emitter.js";
import { authenticateAgent, requireAgent } from "./auth.js";
import { asyncHandler } from "./errors.js";
import { mintStreamTicket, verifyStreamTicket } from "./stream-ticket.js";

export interface StreamRoutesDeps {
  readonly db: PgPool;
  readonly bus: TraceBus;
  readonly chain: AuditChain;
  readonly nowMs: () => number;
  readonly ticketSecret: string;
  readonly heartbeatMs?: number | undefined;
  readonly terminalPollMs?: number | undefined;
}

/** True once the tx has a recorded terminal outcome (poll close condition). */
async function isTerminal(db: PgPool, txId: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM proposal_txs WHERE tx_id=$1 AND outcome_json IS NOT NULL`, [txId]);
  return (r.rowCount ?? 0) > 0;
}

/** Confirm the agent owns this tx (idempotency ledger; foreign → false). */
async function ownsTx(db: PgPool, txId: string, agentId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM proposal_idempotency WHERE tx_id=$1 AND agent_id=$2`,
    [txId, agentId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Resolve the stream caller: `?ticket=` first, else a direct X-Agent-Key. */
async function resolveStreamAgent(deps: StreamRoutesDeps, req: Request, txId: string): Promise<string> {
  const ticket = typeof req.query.ticket === "string" ? req.query.ticket : undefined;
  if (ticket !== undefined && ticket !== "") {
    const verdict = verifyStreamTicket(deps.ticketSecret, ticket, deps.nowMs());
    if (!verdict.ok) {
      throw new HttpError(401, "UNAUTHORIZED", `stream ticket ${verdict.reason.toLowerCase()}`, { retryable: false });
    }
    if (verdict.payload.tx_id !== txId) {
      throw new HttpError(403, "FORBIDDEN", "stream ticket bound to a different tx", { retryable: false });
    }
    return verdict.payload.agent_id;
  }
  const id = await authenticateAgent(deps.db, req);
  if (id instanceof HttpError) throw id;
  return id.agentId;
}

export function streamRoutes(deps: StreamRoutesDeps): Router {
  const router = express.Router();
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const terminalPollMs = deps.terminalPollMs ?? 1_000;

  // Browser prep: mint a short-lived ticket for an owned tx (X-Agent-Key auth).
  router.post(
    "/v1/stream-tickets",
    requireAgent(deps.db, "buyer_agent"),
    express.json({ limit: "8kb" }),
    asyncHandler(async (req, res) => {
      const agent = req.agent;
      if (agent === undefined) throw new HttpError(401, "UNAUTHORIZED", "missing agent identity");
      const parsed = StreamTicketRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "VALIDATION_ERROR", "invalid stream-ticket request", {
          details: parsed.error.issues,
          retryable: false,
        });
      }
      const txId = parsed.data.tx_id;
      if (!(await ownsTx(deps.db, txId, agent.agentId))) {
        throw new HttpError(404, "TX_NOT_FOUND", "no such transaction for this agent", { txId, retryable: false });
      }
      const minted = mintStreamTicket(deps.ticketSecret, { agent_id: agent.agentId, tx_id: txId, nowMs: deps.nowMs() });
      res.status(200).json(StreamTicketResponseSchema.parse(minted));
    }),
  );

  router.get("/v1/stream/:txId", asyncHandler(async (req, res) => {
    const txId = String(req.params.txId ?? "");
    const agentId = await resolveStreamAgent(deps, req, txId);
    if (!(await ownsTx(deps.db, txId, agentId))) {
      throw new HttpError(404, "TX_NOT_FOUND", "no such transaction for this agent", { txId, retryable: false });
    }
    await runSseStream(deps, req, res, txId, heartbeatMs, terminalPollMs);
  }));

  return router;
}

/** The long-lived SSE loop for one owned tx (headers not yet sent on entry). */
async function runSseStream(
  deps: StreamRoutesDeps,
  req: Request,
  res: Response,
  txId: string,
  heartbeatMs: number,
  terminalPollMs: number,
): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  // Some proxies buffer until first flush; a retry hint doubles as that flush.
  res.write("retry: 3000\n\n");

  const lastEventIdRaw = req.header("Last-Event-ID") ?? (typeof req.query.lastEventId === "string" ? req.query.lastEventId : "");
  const parsedLast = Number.parseInt(lastEventIdRaw, 10);
  let lastSentSeq = Number.isFinite(parsedLast) && parsedLast > 0 ? parsedLast : 0;

  let closed = false;
  const buffered: Array<{ kind: "durable"; seq: number; frame: string } | { kind: "ephemeral"; frame: string }> = [];
  let replaying = true;

  const writeFrame = (s: string): void => {
    if (!closed && !res.writableEnded) res.write(s);
  };

  // Subscribe FIRST — anything published during replay lands in `buffered`.
  const unsubscribe = deps.bus.subscribe(txChannel(txId), (f) => {
    if (f.kind === "durable") {
      const seq = f.envelope.seq;
      if (replaying) {
        buffered.push({ kind: "durable", seq, frame: formatDurableFrame(f.envelope) });
      } else if (seq > lastSentSeq) {
        lastSentSeq = seq;
        writeFrame(formatDurableFrame(f.envelope));
      }
    } else {
      const frame = formatEphemeralFrame(f.event, f.payload);
      if (replaying) buffered.push({ kind: "ephemeral", frame });
      else writeFrame(frame);
    }
  });

  let heartbeat: ReturnType<typeof setInterval> | undefined = undefined;
  let poll: ReturnType<typeof setInterval> | undefined = undefined;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
    if (poll) clearInterval(poll);
    if (!res.writableEnded) res.end();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);

  // Replay durable history after Last-Event-ID, then flush the buffer (dedup).
  try {
    const history = await deps.chain.tailFor(txId, lastSentSeq);
    for (const row of history) {
      const env = rowToEnvelope(row);
      if (env.seq > lastSentSeq) {
        lastSentSeq = env.seq;
        writeFrame(formatDurableFrame(env));
      }
    }
  } catch {
    // A replay failure must not wedge the socket; live forwarding still works.
  }
  for (const b of buffered) {
    if (closed) break;
    if (b.kind === "durable") {
      if (b.seq > lastSentSeq) {
        lastSentSeq = b.seq;
        writeFrame(b.frame);
      }
    } else {
      writeFrame(b.frame);
    }
  }
  buffered.length = 0;
  replaying = false;

  // Flush any straggler durable rows beyond lastSentSeq, then close for good.
  const finish = async (): Promise<void> => {
    try {
      const tail = await deps.chain.tailFor(txId, lastSentSeq);
      for (const row of tail) {
        const env = rowToEnvelope(row);
        if (env.seq > lastSentSeq) {
          lastSentSeq = env.seq;
          writeFrame(formatDurableFrame(env));
        }
      }
    } catch {
      /* best-effort drain */
    }
    cleanup();
  };

  if (await isTerminal(deps.db, txId)) {
    await finish();
    return;
  }

  heartbeat = setInterval(() => writeFrame(formatCommentPing()), heartbeatMs);
  poll = setInterval(() => {
    void isTerminal(deps.db, txId).then((done) => {
      if (done && !closed) void finish();
    });
  }, terminalPollMs);
}
