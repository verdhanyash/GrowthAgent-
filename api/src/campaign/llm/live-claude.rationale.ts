/**
 * Live claude-opus-5 rationale port (campaign.md §7.2). One non-streaming
 * messages.parse call; the SDK client runs maxRetries: 0 because the retry
 * ladder is OURS (rationale-runner.ts) and must stay test-visible.
 *
 * Sampling knobs (temperature/top_p/top_k) are intentionally absent — removed
 * on claude-opus-5 (400 if sent); `thinking: { type: "adaptive" }` is the
 * on-mode (`budget_tokens` removed). Per-request timeout is milliseconds.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  CAMPAIGN_CONFIG,
  RationalesOutputZ,
  type RationalesOutput,
} from "@growthagent/shared";
import type { RationalePort } from "./rationale.port.js";
import { RationaleParseError } from "./rationale.port.js";
import type { DraftArgs } from "./prompts.js";
import { SYSTEM_PROMPT, buildUserPayload } from "./prompts.js";

export class LiveClaudeRationalePort implements RationalePort {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      maxRetries: 0, // we own the retry ladder explicitly
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  }

  async draft(args: DraftArgs): Promise<RationalesOutput> {
    const response = await this.client.messages.parse(
      {
        model: CAMPAIGN_CONFIG.rationaleModel,
        max_tokens: CAMPAIGN_CONFIG.rationaleMaxTokens, // small output; non-streaming OK
        // NOTE: temperature / top_p / top_k intentionally absent — removed on
        // opus-5 (400 if sent).
        thinking: { type: "adaptive" },
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          { role: "user", content: buildUserPayload(args) },
        ],
        output_config: {
          format: zodOutputFormat(RationalesOutputZ),
        },
      },
      { timeout: CAMPAIGN_CONFIG.rationaleTimeoutMs },
    );
    if (response.parsed_output === null) throw new RationaleParseError();
    return response.parsed_output;
  }
}
