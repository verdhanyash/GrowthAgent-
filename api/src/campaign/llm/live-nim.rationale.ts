/**
 * Live meta/llama-3.3-70b-instruct rationale port (campaign.md §7.2). One
 * non-streaming chat completion through the NIM seam (api/src/llm/nim.ts);
 * nimChat never retries — the ladder in rationale-runner.ts is OURS and stays
 * test-visible (the SDK-era maxRetries: 0 stance, preserved).
 *
 * Structured output rides `nvext.guided_json` with a JSON Schema compiled from
 * RationalesOutputZ via zod/v4's `toJSONSchema` — the same role zodOutputFormat
 * played on the Anthropic seam. The reply is STILL validated through
 * RationalesOutputZ after parsing; anything unparseable or off-schema throws
 * RationaleParseError so the ladder's PARSE_FAILED re-request semantics apply.
 *
 * The frozen system prompt is sent verbatim as the system message: NIM's
 * OpenAI-compatible surface has no cache_control, so prompt caching stops
 * being a wire concern — byte-freeze discipline lives entirely in prompts.ts
 * hashing (provenance + replay keys).
 *
 * Sampling knobs are intentionally absent (parity with the opus-5 stance);
 * `thinking` is gone entirely (Anthropic-only). Per-request timeout is
 * milliseconds (CAMPAIGN_CONFIG.rationaleTimeoutMs).
 */
import process from "node:process";
import { toJSONSchema } from "zod/v4";
import {
  CAMPAIGN_CONFIG,
  RationalesOutputZ,
  type RationalesOutput,
} from "@growthagent/shared";
import { nimChat, parseJsonObjectContent } from "../../llm/nim.js";
import type { RationalePort } from "./rationale.port.js";
import { RationaleParseError } from "./rationale.port.js";
import type { DraftArgs } from "./prompts.js";
import { SYSTEM_PROMPT, buildUserPayload } from "./prompts.js";

/** Wire-level grammar for nvext.guided_json; pure, so compiled once. */
const RATIONALES_JSON_SCHEMA = toJSONSchema(RationalesOutputZ);

export class LiveNimRationalePort implements RationalePort {
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const resolved = (apiKey ?? process.env.NVIDIA_API_KEY ?? "").trim();
    if (resolved === "") {
      throw new Error(
        "LiveNimRationalePort needs an NVIDIA API key — pass one to the " +
          "constructor or set NVIDIA_API_KEY",
      );
    }
    this.apiKey = resolved;
  }

  async draft(args: DraftArgs): Promise<RationalesOutput> {
    const { contentText } = await nimChat({
      apiKey: this.apiKey,
      model: CAMPAIGN_CONFIG.rationaleModel,
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildUserPayload(args) },
      ],
      maxTokens: CAMPAIGN_CONFIG.rationaleMaxTokens, // small output; non-streaming OK
      timeoutMs: CAMPAIGN_CONFIG.rationaleTimeoutMs,
      jsonSchema: RATIONALES_JSON_SCHEMA,
    });

    let parsed: unknown;
    try {
      parsed = parseJsonObjectContent(contentText);
    } catch (cause) {
      throw new RationaleParseError(
        `rationale reply was not parseable JSON: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    const validated = RationalesOutputZ.safeParse(parsed);
    if (!validated.success) {
      throw new RationaleParseError(
        `rationale reply failed schema validation: ${validated.error.message}`,
      );
    }
    return validated.data;
  }
}
