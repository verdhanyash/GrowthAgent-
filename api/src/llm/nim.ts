/**
 * NVIDIA NIM client — the single LLM API seam for all four agents.
 *
 * Provider switch (2026-08-26, BUILD_LOG M5b): @anthropic-ai/sdk replaced by
 * this zero-dependency fetch client against NIM's OpenAI-compatible chat
 * completions endpoint. Everything ABOVE this file is unchanged: ports, byte-
 * frozen prompts, zod/v4 output schemas, retry ladders, PARSE_FAILED
 * re-request semantics, chaos toggles, DEMO_STABLE_MODE record/replay.
 *
 * Contract notes:
 * - Structured output rides as `nvext.guided_json` (NIM's grammar-constrained
   decoding) with a JSON Schema compiled from the module's zod/v4 schema —
   the same role zodOutputFormat played before. Unsupported-model rejections
   surface as loud 4xx NON_RETRYABLE failures (fail-loud stance).
 * - Sampling knobs are intentionally absent — parity with the Anthropic-era
   stance ("removed on opus-5"); defaults only.
 * - SDK auto-retry has no equivalent here because there IS no SDK: plain
   fetch, one shot per call. The modules' own ladders own retries exactly as
   before.
 * - Failure taxonomy: NimHttpError carries status (+ parsed retry-after);
   NimNetworkError covers fetch throws and timeout aborts. classify helpers
   mirror the old typed-error semantics: {408,409,429,5xx,network} →
   RETRYABLE; other 4xx and UNKNOWN → NON_RETRYABLE (fail fast).
 */
import process from "node:process";

export const DEFAULT_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

export function nimBaseUrl(): string {
  const fromEnv = process.env.NIM_BASE_URL?.trim();
  return fromEnv !== undefined && fromEnv !== ""
    ? fromEnv
    : DEFAULT_NIM_BASE_URL;
}

/** HTTP-level failure from the NIM endpoint. `retryAfterMs` parses a numeric
 *  `retry-after` header when present (seconds), else null. */
export class NimHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, headers?: Headers) {
    super(`NIM HTTP ${status}: ${message}`);
    this.name = "NimHttpError";
    this.status = status;
    const ra = headers?.get("retry-after") ?? null;
    const parsed = ra !== null ? Number.parseFloat(ra) : Number.NaN;
    this.retryAfterMs = Number.isFinite(parsed)
      ? Math.round(parsed * 1000)
      : null;
  }
}

/** Transport-level failure: fetch threw (DNS, conn refused, reset) or the
 *  request timed out via abort. Always RETRYABLE-class. */
export class NimNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NimNetworkError";
  }
}

export interface NimMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface NimChatArgs {
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt: string;
  /** Conversation turns after the system prompt (repair turns append here). */
  readonly messages: readonly NimMessage[];
  readonly maxTokens: number;
  readonly timeoutMs: number;
  /** JSON Schema (compiled via zod/v4 `toJSONSchema`) constraining generation. */
  readonly jsonSchema?: unknown;
}

export interface NimUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface NimChatResult {
  readonly contentText: string;
  readonly usage: NimUsage | null;
  readonly finishReason: string | null;
}

interface NimWireChoice {
  readonly message?: { readonly content?: unknown };
  readonly finish_reason?: unknown;
}
interface NimWireResponse {
  readonly choices?: readonly NimWireChoice[];
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
  readonly error?: { readonly message?: unknown };
}

/** One non-streaming chat completion. Throws NimHttpError / NimNetworkError;
 *  never retries (the caller's ladder owns that decision). */
export async function nimChat(args: NimChatArgs): Promise<NimChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${nimBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.apiKey}`,
        accept: "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        max_tokens: args.maxTokens,
        // Sampling knobs intentionally absent (see header note).
        messages: [
          { role: "system", content: args.systemPrompt },
          ...args.messages,
        ],
        ...(args.jsonSchema !== undefined
          ? { nvext: { guided_json: args.jsonSchema } }
          : {}),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    // Abort (timeout) and raw fetch failures are the same transport class.
    throw new NimNetworkError(
      e instanceof Error ? `NIM request failed: ${e.message}` : "NIM request failed",
    );
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await res.text().catch(() => "");
  let wire: NimWireResponse | null = null;
  if (bodyText !== "") {
    try {
      wire = JSON.parse(bodyText) as NimWireResponse;
    } catch {
      // Non-JSON error body — handled below through the !res.ok / empty paths.
    }
  }

  if (!res.ok) {
    const detail =
      typeof wire?.error?.message === "string"
        ? wire.error.message
        : bodyText !== ""
          ? bodyText.slice(0, 500)
          : `HTTP ${res.status}`;
    throw new NimHttpError(res.status, detail, res.headers);
  }
  if (wire === null) {
    throw new NimNetworkError("NIM returned an empty or non-JSON success body");
  }

  const choice = wire.choices?.[0];
  const content = choice?.message?.content;
  const usage = wire.usage;
  return {
    contentText: typeof content === "string" ? content : "",
    usage:
      typeof usage?.prompt_tokens === "number" &&
      typeof usage?.completion_tokens === "number"
        ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens }
        : null,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
  };
}

/** Defensive fence-strip + JSON parse of a model reply expected to be one
 *  JSON object. Throws SyntaxError on malformed content — adapters translate
 *  that into their module's PARSE_FAILED vocabulary. */
export function parseJsonObjectContent(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "")
    : trimmed;
  return JSON.parse(unfenced);
}

export type NimTransportClass = "RETRYABLE" | "NON_RETRYABLE";

/**
 * Transport failure classification mirroring the Anthropic-era typed-error
 * semantics: rate limit / server errors / timeouts / connection failures are
 * retryable; client mistakes (bad key, bad params, unsupported model field)
 * and UNKNOWN error shapes fail fast.
 */
export function classifyNimTransport(e: unknown): NimTransportClass {
  if (e instanceof NimHttpError) {
    return e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500
      ? "RETRYABLE"
      : "NON_RETRYABLE";
  }
  if (e instanceof NimNetworkError) return "RETRYABLE";
  return "NON_RETRYABLE";
}

/** Server-suggested retry delay when advertised, else the caller's fallback. */
export function nimRetryDelayMs(e: unknown, fallbackMs: number): number {
  return e instanceof NimHttpError && e.retryAfterMs !== null
    ? e.retryAfterMs
    : fallbackMs;
}
