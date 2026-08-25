/**
 * Gatekeeper barrel (gatekeeper.md §2). THE public surface is
 * `evaluateProposal` — pure, synchronous, total. Everything impure stays out
 * of this directory by contract; see api/src/services/ for the velocity store
 * and injection tagger adapters that feed it immutable snapshots.
 */
import { evaluateProposal } from "./engine.js";
export { evaluateProposal };
export type { EvaluateProposalInput, GateContext } from "./context.js";
export { buildContext, mergeLines } from "./context.js";
export { aggregate, type Aggregation } from "./aggregate.js";
export { ImpossibleStateError } from "./errors.js";
export { sha256Hex } from "./digest.js";
export {
  RULE_REGISTRY,
  ADVISORY_CODES,
  ESCALATION_CODES,
  isDeclineCode,
  type RuleDefinition,
  type RuleVerdict,
  type Severity,
} from "./rules/registry.js";
