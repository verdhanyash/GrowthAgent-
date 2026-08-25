/**
 * Live meta/llama-3.3-70b-instruct enrichment port via the NVIDIA NIM seam
 * (llm/nim.ts). One non-streaming chat-completions call per SKU; plain fetch,
 * one shot per call — the ladder is ours (batch.ts).
 *
 * Provider switch (Anthropic claude-opus-5 → NIM): sampling knobs stay
 * intentionally absent (same stance as before), `thinking` has no equivalent
 * here and is gone, cache_control is gone (NIM gets SYSTEM_PROMPT as the
 * system message). Structured output rides nvext.guided_json over
 * toJSONSchema(EnrichmentOutputZ) — the same role zodOutputFormat played.
 * Guided decoding is a constraint, not a guarantee, so the reply is still
 * parsed defensively and validated through EnrichmentOutputZ; any mismatch
 * throws EnrichmentParseError, which batch.ts turns into exactly one
 * PARSE_FAILED re-request.
 */
import process from "node:process";
import { toJSONSchema } from "zod/v4";
import {
  CATALOG_CONFIG,
  EnrichmentOutputZ,
  type EnrichmentOutput,
} from "@growthagent/shared";
import { nimChat, parseJsonObjectContent } from "../llm/nim.js";
import type { EnrichmentArgs, EnrichmentPort } from "./enrichment.port.js";
import { EnrichmentParseError } from "./enrichment.port.js";
import { SYSTEM_PROMPT, buildUserPayload } from "./prompts.js";

/** Compiled once — EnrichmentOutputZ and its JSON projection are static. */
const ENRICHMENT_JSON_SCHEMA = toJSONSchema(EnrichmentOutputZ);

export class LiveNimEnrichmentPort implements EnrichmentPort {
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.NVIDIA_API_KEY;
    if (key === undefined || key === "") {
      throw new Error(
        "LiveNimEnrichmentPort requires an NVIDIA API key — pass one to the constructor or set NVIDIA_API_KEY",
      );
    }
    this.apiKey = key;
  }

  async enrich(args: EnrichmentArgs): Promise<EnrichmentOutput> {
    const response = await nimChat({
      apiKey: this.apiKey,
      model: CATALOG_CONFIG.enrichmentModel,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPayload(args) }],
      maxTokens: CATALOG_CONFIG.enrichmentMaxTokens,
      timeoutMs: CATALOG_CONFIG.enrichmentTimeoutMs,
      jsonSchema: ENRICHMENT_JSON_SCHEMA,
    });

    let raw: unknown;
    try {
      raw = parseJsonObjectContent(response.contentText);
    } catch {
      throw new EnrichmentParseError("model content was not a parseable JSON object");
    }
    const validated = EnrichmentOutputZ.safeParse(raw);
    if (!validated.success) {
      throw new EnrichmentParseError("model output failed EnrichmentOutputZ validation");
    }
    return validated.data;
  }
}
