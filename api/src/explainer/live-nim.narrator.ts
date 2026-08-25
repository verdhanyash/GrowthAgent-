/**
 * Live meta/llama-3.3-70b-instruct narrator port (NIM seam, api/src/llm/nim).
 * One chat-completions call per attempt; no client-side retry (the ladder is
 * ours).
 *
 * Provider-switch notes (2026-08-26, BUILD_LOG M5b):
 * - Structured output rides as nvext.guided_json with a JSON Schema compiled
 *   from NarrativeOutputZ via zod/v4 toJSONSchema — the same role
 *   zodOutputFormat played before.
 * - The Anthropic-era `thinking:{type:"adaptive",display:"summarized"}` and
 *   system cache_control are GONE: NIM llama-3.3 has no reasoning-block
 *   summary and no ephemeral caching — nothing replaces them.
 * - The reply must be ONE JSON object: fence-strip + parse, then schema
 *   validation. Either failure throws NarrationParseError so narrate()'s
 *   PARSE_FAILED single-re-request semantics still apply.
 */
import process from "node:process";
import { toJSONSchema } from "zod/v4";
import { nimChat, parseJsonObjectContent } from "../llm/nim.js";
import {
  NarrativeOutputZ,
  type NarrativeOutput,
} from "@growthagent/shared";
import type { NarratorPort } from "./narrator.port.js";
import { NarrationParseError } from "./narrator.port.js";
import {
  NARRATOR_MODEL,
  SYSTEM_PROMPT,
  buildUserPayload,
} from "./prompts.js";

const NARRATOR_MAX_TOKENS = 3000;
const NARRATOR_TIMEOUT_MS = 30_000;

const NARRATIVE_JSON_SCHEMA: unknown = toJSONSchema(NarrativeOutputZ);

export class LiveNimNarratorPort implements NarratorPort {
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const resolved = apiKey ?? process.env.NVIDIA_API_KEY?.trim();
    if (resolved === undefined || resolved === "") {
      throw new Error(
        "LiveNimNarratorPort needs an NVIDIA API key — pass one to the " +
          "constructor or set NVIDIA_API_KEY",
      );
    }
    this.apiKey = resolved;
  }

  async narrate(args: Parameters<NarratorPort["narrate"]>[0]): Promise<NarrativeOutput> {
    const result = await nimChat({
      apiKey: this.apiKey,
      model: NARRATOR_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPayload(args) }],
      maxTokens: NARRATOR_MAX_TOKENS,
      timeoutMs: NARRATOR_TIMEOUT_MS,
      jsonSchema: NARRATIVE_JSON_SCHEMA,
    });
    let candidate: unknown;
    try {
      candidate = parseJsonObjectContent(result.contentText);
    } catch (e) {
      throw new NarrationParseError(
        e instanceof Error
          ? `narration reply was not a JSON object: ${e.message}`
          : "narration reply was not a JSON object",
      );
    }
    const verdict = NarrativeOutputZ.safeParse(candidate);
    if (!verdict.success) {
      throw new NarrationParseError(
        `narration reply failed schema validation: ${verdict.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return verdict.data;
  }
}
