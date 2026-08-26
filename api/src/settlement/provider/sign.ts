/**
 * Signature primitives — ported VERBATIM from docs/design/settlement.md §4,
 * plus sha256Hex (the §8.3 step-2 body-digest fallback needs the same
 * raw-bytes discipline, so it lives with the other byte-exact helpers).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hmacSha256Hex(secret: string, rawBody: Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Constant-time compare; burns a comparison even on length mismatch to avoid
 *  a length oracle. House hardening; Razorpay docs don't mandate it (V7). */
export function secureCompareHex(
  received: string | null | undefined,
  expectedHex: string,
): boolean {
  if (!received) return false;
  const a = Buffer.from(received.trim().toLowerCase(), "utf8");
  const b = Buffer.from(expectedHex, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b); // burn a comparison anyway — no length oracle
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Hex sha256 over EXACT raw bytes — event-id fallback + payload digests. */
export function sha256Hex(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}
