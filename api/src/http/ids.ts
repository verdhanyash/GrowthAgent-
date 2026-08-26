/**
 * api/src/http/ids.ts — prefixed, Crockford-base32, ULID-shaped id minter for
 * the HTTP layer (api-contract.md §2.2). Time-ordered 10-char millisecond head
 * + 16-char CSPRNG tail = 26 chars, matching the `^<prefix>_[0-9A-HJKMNP-TV-Z]{26}$`
 * shape the shared primitives (TxId/MandateId) and the V7 CHECK constraint bind.
 *
 * The pipeline's approvals.ts already ships an identical shape for `apr_`; this
 * is the same construction generalized so tx_/cm_/req_ all mint here.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, no I/L/O/U

/** 26-char Crockford body: 10 time chars (ms) + 16 random chars. */
function ulidBody(nowMs: number): string {
  let t = Math.floor(nowMs);
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let tail = "";
  for (let i = 0; i < 16; i++) tail += ALPHABET[rand[i]! % 32];
  return `${time}${tail}`;
}

export function mintTxId(nowMs = Date.now()): string {
  return `tx_${ulidBody(nowMs)}`;
}

export function mintMandateId(nowMs = Date.now()): string {
  return `cm_${ulidBody(nowMs)}`;
}

export function mintRequestId(nowMs = Date.now()): string {
  return `req_${ulidBody(nowMs)}`;
}
