/**
 * Live meta/llama-3.3-70b-instruct transport via the NVIDIA NIM seam
 * (negotiation.md §3.1–§3.7, llm/nim.ts). There is NO SDK here — plain fetch,
 * one shot per call — so nothing auto-retries above this layer: it owns the
 * retry ladder and the 12s wall budget, and timeouts are never silently
 * amplified into timeout × (retries+1).
 *
 * Provider switch (Anthropic claude-opus-5 → NIM), semantics preserved 1:1:
 * - Structured output rides nvext.guided_json over
 *   toJSONSchema(NegotiationProposalZ) — the same role zodOutputFormat played.
 *   Guided decoding is a constraint, not a guarantee, so the reply is parsed
 *   defensively and validated through NegotiationProposalZ.safeParse; any
 *   mismatch yields parsed_output === null, which routes to stage repair-or-
 *   fallback exactly as the SDK's null parsed_output did.
 * - `thinking` is gone (llama-3.3 emits no reasoning blocks); thinking_summary
 *   stays "" so downstream consumers see an unchanged TransportResult shape.
 * - cache_control markers are an Anthropic wire concept and never travel:
 *   system_blocks texts join into ONE NIM system message ("\n\n"). Rebuilding
 *   the request for the retry attempt still produces byte-identical bytes.
 * - Failure taxonomy rebased on NimHttpError/NimNetworkError +
 *   classifyNimTransport (§3.6: typed errors only, never string matching).
 */
import process from "node:process";
import { toJSONSchema } from "zod/v4";
import type { NegotiationProposal } from "@growthagent/shared";
import { NegotiationProposalZ } from "@growthagent/shared";
import {
  NimHttpError,
  classifyNimTransport,
  nimChat,
  nimRetryDelayMs,
  parseJsonObjectContent,
  type NimMessage,
} from "../llm/nim.js";
import type { NimNetworkError } from "../llm/nim.js";
import type { RenderedRequest } from "./prompt.js";
import type {
  AttemptLog,
  NegotiationTransport,
  TransportKeyInputs,
  TransportResult,
} from "./transport.types.js";

export const NEGOTIATION_WALL_BUDGET_MS = 12_000;
const FIRST_ATTEMPT_TIMEOUT_MS = 10_500;

/**
 * NIM finish-reason → the stop_reason vocabulary stage.ts consumes
 * ("max_tokens"/"refusal" branches must keep firing on truncation/refusal).
 * Translation lives HERE so downstream business logic stays provider-neutral.
 */
export function mapStopReason(finishReason: string | null): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case null:
      return "unknown";
    default:
      return finishReason;
  }
}
const RETRY_ELIGIBLE_ELAPSED_MS = 5_000;
const REPAIR_ELIGIBLE_ELAPSED_MS = 6_500;
const RATE_LIMIT_CAP_MS = 1_500;
const FIXED_BACKOFF_MS = 750;

/** Compiled once — NegotiationProposalZ and its JSON projection are static. */
const NEGOTIATION_JSON_SCHEMA = toJSONSchema(NegotiationProposalZ);

export interface LiveTransportOptions {
  readonly apiKey?: string | undefined;
  /** Demo chaos hooks, intercepted at this seam so degradation paths are
   *  exercisable in live mode too. */
  readonly force_llm_timeout?: boolean | undefined;
  readonly force_gateway_error?: boolean | undefined;
}

/** §3.6 — typed NIM exceptions only, never string matching. Rate limit,
 *  timeouts/connection failures, and server errors retry; every other 4xx
 *  (bad key, bad params, unsupported model/schema field) and UNKNOWN error
 *  shapes fall back immediately. */
export function isRetryable(e: unknown): e is NimHttpError | NimNetworkError {
  return classifyNimTransport(e) === "RETRYABLE";
}
// NON-retryable → immediate fallback: NimHttpError{400,401,403,404,422,...},
// plus anything that is neither NIM error class.

function errorClass(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}

function errStatus(e: unknown): number | null {
  return e instanceof NimHttpError ? e.status : null;
}

/** Exported for the §8.2 typed-error classification tests — pure otherwise.
 *  A server-advertised retry-after wins when present, else the fixed backoff;
 *  always capped at RATE_LIMIT_CAP_MS. */
export function retryDelayMs(e: unknown): number {
  return Math.min(nimRetryDelayMs(e, FIXED_BACKOFF_MS), RATE_LIMIT_CAP_MS);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/** Rendered messages → NIM chat turns. Text-block arrays flatten to one
 *  string ("\n\n" between blocks); the mid-conversation tagger advisory keeps
 *  its system role — the OpenAI-compatible endpoint accepts system turns
 *  anywhere in the array, and role-preserving mapping keeps the repair-turn
 *  append byte-identical. (NimMessage's TS union merely doesn't name
 *  `system`; the cast never rewrites a role.) */
function toNimMessages(msgs: RenderedRequest["messages"]): NimMessage[] {
  return msgs.map((m) => ({
    role: m.role as NimMessage["role"],
    content:
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => b.text).join("\n\n"),
  }));
}

export class LiveNimTransport implements NegotiationTransport {
  private readonly apiKey: string;
  private readonly opts: LiveTransportOptions;

  constructor(opts: LiveTransportOptions = {}) {
    this.opts = opts;
    const key = opts.apiKey ?? process.env.NVIDIA_API_KEY;
    if (key === undefined || key === "") {
      throw new Error(
        "LiveNimTransport requires an NVIDIA API key — pass one to the constructor or set NVIDIA_API_KEY",
      );
    }
    this.apiKey = key;
  }

  async execute(
    rendered: RenderedRequest,
    _key: TransportKeyInputs,
  ): Promise<TransportResult> {
    const t0 = Date.now();
    const attempts: AttemptLog[] = [];
    const elapsed = (): number => Date.now() - t0;

    const callOnce = async (
      msgs: RenderedRequest["messages"],
      kind: AttemptLog["kind"],
    ): Promise<
      | { ok: true; result: TransportResult }
      | { ok: false; error: unknown; attempt: AttemptLog }
    > => {
      const a0 = Date.now();
      try {
        if (this.opts.force_llm_timeout) {
          await sleep(NEGOTIATION_WALL_BUDGET_MS + 1);
        }
        if (this.opts.force_gateway_error) {
          throw new NimHttpError(500, "chaos");
        }
        const result = await nimChat({
          apiKey: this.apiKey,
          model: rendered.params.model,
          // Frozen system blocks, joined; cache_control never goes on the wire.
          systemPrompt: rendered.system_blocks.map((b) => b.text).join("\n\n"),
          messages: toNimMessages(msgs),
          maxTokens: rendered.params.max_tokens,
          // Sampling knobs intentionally absent (same stance as opus-5).
          timeoutMs: Math.min(FIRST_ATTEMPT_TIMEOUT_MS, Math.max(1, NEGOTIATION_WALL_BUDGET_MS - elapsed())),
          jsonSchema: NEGOTIATION_JSON_SCHEMA,
        });
        // Guided decoding constrains but does not guarantee: defensive fence-
        // strip + parse, then schema validation. Any miss → parsed_output null
        // (the stage routes that to repair-or-fallback).
        let proposal: NegotiationProposal | null = null;
        try {
          const candidate = parseJsonObjectContent(result.contentText);
          const checked = NegotiationProposalZ.safeParse(candidate);
          if (checked.success) proposal = checked.data;
        } catch {
          proposal = null; // unparseable JSON object → PARSE_FAILED vocabulary
        }
        const attempt: AttemptLog = {
          kind,
          latency_ms: Date.now() - a0,
          error_class: null,
          status: null,
          usage: result.usage
            ? {
                input_tokens: result.usage.input_tokens,
                output_tokens: result.usage.output_tokens,
                cache_read_input_tokens: undefined, // no cache telemetry on NIM
              }
            : null,
        };
        return {
          ok: true,
          result: {
            parsed_output: proposal,
            raw_text: result.contentText,
            // llama-3.3 has no reasoning blocks; field kept for downstream
            // shape stability.
            thinking_summary: "",
            usage: attempt.usage,
            stop_reason: mapStopReason(result.finishReason),
            latency_ms: Date.now() - a0,
            attempts: [...attempts, attempt],
          },
        };
      } catch (e) {
        return {
          ok: false,
          error: e,
          attempt: {
            kind,
            latency_ms: Date.now() - a0,
            error_class: errorClass(e),
            status: errStatus(e),
            usage: null,
          },
        };
      }
    };

    // ---- initial attempt -------------------------------------------------
    let first = await callOnce(rendered.messages, "initial");
    if (first.ok) return first.result;
    attempts.push(first.attempt);

    // ---- one retry, only for retryable classes within budget --------------
    const nonRetryable = !isRetryable(first.error);
    if (
      !nonRetryable &&
      elapsed() < RETRY_ELIGIBLE_ELAPSED_MS &&
      elapsed() + retryDelayMs(first.error) < NEGOTIATION_WALL_BUDGET_MS
    ) {
      await sleep(retryDelayMs(first.error));
      const second = await callOnce(rendered.messages, "retry"); // byte-identical request (cache-stable)
      if (second.ok) return second.result;
      attempts.push(second.attempt);
      first = second;
    }

    // ---- one schema-repair attempt (§3.7) --------------------------------
    // Reached only when both attempts failed with a transport-class error AND
    // budget remains. (Parse-failure repairs happen inside `ok` results with
    // parsed_output === null — the stage routes those here via re-execute.)
    if (
      isRetryable(first.error) &&
      elapsed() < REPAIR_ELIGIBLE_ELAPSED_MS
    ) {
      const repairMsgs: RenderedRequest["messages"] = [
        ...rendered.messages,
        { role: "assistant", content: first.error.message },
        {
          role: "user",
          content:
            "Your previous response failed schema validation. Respond again with exactly one valid JSON object.",
        },
      ];
      const repair = await callOnce(repairMsgs, "repair");
      if (repair.ok) return repair.result;
      attempts.push(repair.attempt);
    }

    throw first.error; // stage converts to fallback path
  }
}
