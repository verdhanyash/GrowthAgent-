/**
 * api/src/http/stream-ticket.ts — short-lived SSE auth ticket (api-contract §5.3).
 *
 * Browsers can't attach headers to EventSource, so `POST /v1/stream-tickets`
 * (X-Agent-Key auth) mints a 60 s ticket bound to {agent_id, tx_id, exp}:
 *
 *   ticket = b64url(json(payload)) + "." + b64url(hmacSha256(SECRET, b64url(json(payload))))
 *
 * The HMAC covers the base64url of the payload (not the raw json) so verify
 * re-derives from the exact transmitted bytes. Non-browser clients skip the
 * ticket and send X-Agent-Key directly (§5.3); ownership is enforced either way.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface TicketPayload {
  readonly agent_id: string;
  readonly tx_id: string;
  readonly exp: number; // epoch ms
}

const b64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlToBuf(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(secret: string, payloadB64: string): string {
  return b64url(createHmac("sha256", secret).update(payloadB64, "utf8").digest());
}

export const DEFAULT_TICKET_TTL_MS = 60_000;

export function mintStreamTicket(
  secret: string,
  args: { agent_id: string; tx_id: string; nowMs: number; ttlMs?: number },
): { ticket: string; expires_at: string; expires_in_s: number } {
  const ttl = args.ttlMs ?? DEFAULT_TICKET_TTL_MS;
  const payload: TicketPayload = { agent_id: args.agent_id, tx_id: args.tx_id, exp: args.nowMs + ttl };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const ticket = `${payloadB64}.${sign(secret, payloadB64)}`;
  return {
    ticket,
    expires_at: new Date(payload.exp).toISOString(),
    expires_in_s: Math.round(ttl / 1000),
  };
}

export type TicketVerdict =
  | { ok: true; payload: TicketPayload }
  | { ok: false; reason: "MALFORMED" | "BAD_SIG" | "EXPIRED" };

export function verifyStreamTicket(secret: string, ticket: string, nowMs: number): TicketVerdict {
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot === ticket.length - 1) return { ok: false, reason: "MALFORMED" };
  const payloadB64 = ticket.slice(0, dot);
  const sigB64 = ticket.slice(dot + 1);
  const expectB64 = sign(secret, payloadB64);
  const a = Buffer.from(sigB64, "utf8");
  const b = Buffer.from(expectB64, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "BAD_SIG" };
  let payload: TicketPayload;
  try {
    const decoded = JSON.parse(b64urlToBuf(payloadB64).toString("utf8")) as TicketPayload;
    if (
      typeof decoded.agent_id !== "string" ||
      typeof decoded.tx_id !== "string" ||
      typeof decoded.exp !== "number"
    ) {
      return { ok: false, reason: "MALFORMED" };
    }
    payload = decoded;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (nowMs >= payload.exp) return { ok: false, reason: "EXPIRED" };
  return { ok: true, payload };
}
