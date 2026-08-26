/**
 * api/src/http/crypto.ts — the Node-side crypto seam for the HTTP layer.
 *
 * shared/ stays crypto-free (web imports it): `verifyCartMandate` takes an
 * injected `MandateCrypto`. This module is that implementation for the server,
 * plus the small primitives auth / stream-tickets need. Base64 comparisons go
 * through `crypto.timingSafeEqual` on equal-length buffers (length-guarded, so
 * a length mismatch is a fast, safe `false` rather than a throw).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MandateCrypto } from "@growthagent/shared";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function hmacSha256B64(secret: string, s: string): string {
  return createHmac("sha256", secret).update(s, "utf8").digest("base64");
}

/** Constant-time-ish equality for two utf8 strings (used on digests/tokens). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** MandateCrypto bound to the server's clock (injected so tests can freeze it). */
export function nodeMandateCrypto(nowIso: () => string): MandateCrypto {
  return {
    sha256hex: sha256Hex,
    hmacSha256b64: hmacSha256B64,
    timingSafeEqB64: timingSafeEqualStr,
    nowIso,
  };
}
