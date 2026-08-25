/**
 * Live claude-opus-5 enrichment port. One non-streaming messages.parse call
 * per SKU; SDK client maxRetries: 0 — the ladder is ours (batch.ts).
 * Sampling knobs intentionally absent (removed on claude-opus-5, 400 if
 * sent); adaptive thinking on; system block ephemeral-cached.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  CATALOG_CONFIG,
  EnrichmentOutputZ,
  type EnrichmentOutput,
} from "@growthagent/shared";
import type { EnrichmentArgs, EnrichmentPort } from "./enrichment.port.js";
import { EnrichmentParseError } from "./enrichment.port.js";
import { SYSTEM_PROMPT, buildUserPayload } from "./prompts.js";

export class LiveClaudeEnrichmentPort implements EnrichmentPort {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      maxRetries: 0,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  }

  async enrich(args: EnrichmentArgs): Promise<EnrichmentOutput> {
    const response = await this.client.messages.parse(
      {
        model: CATALOG_CONFIG.enrichmentModel,
        max_tokens: CATALOG_CONFIG.enrichmentMaxTokens,
        thinking: { type: "adaptive" },
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: buildUserPayload(args) }],
        output_config: {
          format: zodOutputFormat(EnrichmentOutputZ),
        },
      },
      { timeout: CATALOG_CONFIG.enrichmentTimeoutMs },
    );
    if (response.parsed_output === null) throw new EnrichmentParseError();
    return response.parsed_output;
  }
}
