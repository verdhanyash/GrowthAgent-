/**
 * input_digest = sha256(canonicalJson(inputs)) — gatekeeper.md §6.1 / I-8.
 * Synchronous and deterministic, so evaluateProposal stays pure. Lives in the
 * api package (node:crypto is a deterministic builtin, not IO); the canonical
 * serialization itself is shared.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@growthagent/shared";

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
