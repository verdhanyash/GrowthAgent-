/**
 * Campaign audit-event payload types (campaign.md §12.4). Appended via the
 * shared hash-chained audit service with correlation_id = run_id, tx_id =
 * null; the chain machinery itself lives in the audit-log module (M3).
 *
 * CAMPAIGN_RATIONALE_FALLBACK.rejected_rationale is deliberately retained —
 * it is the exact artifact the explainer-agent and demo narrator use to show
 * "what the AI tried vs what shipped."
 */
import type {
  LlmInvocation,
  Opportunity,
  OpportunityType,
  PrioritySetStatus,
} from "./schema.js";

export type RationaleFallbackVerdict =
  | "MISSING_METRIC"
  | "INVENTED_NUMBER"
  | "PORT_FAILURE"
  | "NO_INDEX";

export type SuppressionReason = "SKU_ALREADY_CLAIMED" | "SET_FULL";

export type CampaignAuditEvent =
  | {
      type: "CAMPAIGN_RUN_STARTED";
      run_id: string;
      as_of: string;
      trigger: "SEED" | "TIMER" | "MANUAL";
    }
  | {
      type: "CAMPAIGN_OPPORTUNITIES_EMITTED";
      run_id: string;
      count: number;
      by_type: Record<OpportunityType, number>;
      opportunities: Array<
        Pick<Opportunity, "opportunity_id" | "type" | "skus" | "weight">
      >;
    }
  | {
      type: "CAMPAIGN_PRIORITY_SET_PUBLISHED";
      run_id: string;
      set_id: string;
      priority_set_version: number;
      status: PrioritySetStatus;
      entry_count: number;
      llm_invocation: LlmInvocation | null; // full payload in priority_sets.payload
    }
  | {
      type: "CAMPAIGN_RATIONALE_FALLBACK";
      run_id: string;
      entry_id: string;
      opportunity_id: string;
      verdict: RationaleFallbackVerdict;
      rejected_rationale: string;
    }
  | {
      type: "CAMPAIGN_SET_SUPPRESSED_OPPORTUNITY";
      run_id: string;
      opportunity_id: string;
      reason: SuppressionReason;
    }
  | {
      type: "CAMPAIGN_RUN_FAILED";
      run_id: string;
      phase: "ANALYTICS" | "LLM" | "PUBLISH";
      error_kind: string;
      message: string;
      previous_set_retained: boolean;
    };
