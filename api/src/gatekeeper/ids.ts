/**
 * Rule ids and reason-code unions — re-exported from the shared contract
 * (gatekeeper.md §3.6, verbatim; see schemas.ts normalization note for the
 * two velocity decline codes added per §6).
 */
export {
  RULE_IDS,
  type AdvisoryCode,
  type DeclineCode,
  type EscalationCode,
  type GateOutcome,
  type RuleId,
} from "@growthagent/shared";
