/**
 * LiveClaudeTransport (negotiation.md §3.1–§3.7). SDK auto-retry is DISABLED
 * — this layer owns the retry ladder and the 12s wall budget, so timeouts are
 * never silently amplified into timeout × (retries+1).
 *
 * Verified SDK facts relied on (negotiation.md §9): messages.parse +
 * zodOutputFormat; parsed_output null-on-failure; thinking adaptive/summarized;
 * temperature/top_p/top_k REMOVED on opus-5 (omitted); typed error classes
 * with APIConnectionError ⊂ APIError (catch order matters); per-request
 * timeout in ms.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { APIError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { NegotiationProposal } from "@growthagent/shared";
import { NegotiationProposalZ } from "@growthagent/shared";
import type {
  AttemptLog,
  NegotiationTransport,
  TransportKeyInputs,
  TransportResult,
} from "./transport.types.js";
import type { RenderedRequest } from "./prompt.js";

export const NEGOTIATION_WALL_BUDGET_MS = 12_000;
const FIRST_ATTEMPT_TIMEOUT_MS = 10_500;
const RETRY_ELIGIBLE_ELAPSED_MS = 5_000;
const REPAIR_ELIGIBLE_ELAPSED_MS = 6_500;
const RATE_LIMIT_CAP_MS = 1_500;
const FIXED_BACKOFF_MS = 750;

export interface LiveTransportOptions {
  readonly apiKey?: string | undefined;
  /** Demo chaos hooks, intercepted at this seam so degradation paths are
   *  exercisable in live mode too. */
  readonly force_llm_timeout?: boolean | undefined;
  readonly force_gateway_error?: boolean | undefined;
}

/** §3.6 — SDK typed exceptions only, never string matching. */
export function isRetryable(e: unknown): e is APIError {
  return (
    e instanceof Anthropic.RateLimitError ||
    e instanceof Anthropic.InternalServerError ||
    e instanceof Anthropic.APIConnectionError
  );
}
// NON-retryable → immediate fallback: BadRequestError (incl. any param mistake),
// AuthenticationError, PermissionDeniedError, NotFoundError, UnprocessableEntityError.

function errorClass(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}

function errStatus(e: unknown): number | null {
  if (e instanceof Anthropic.APIError && typeof e.status === "number") return e.status;
  return null;
}

/** Exported for the §8.2 typed-error classification tests — pure otherwise. */
export function retryDelayMs(e: unknown): number {
  if (e instanceof Anthropic.RateLimitError) {
    const head = e.headers?.get("retry-after") ?? undefined;
    const parsed = typeof head === "string" ? Number.parseFloat(head) : Number.NaN;
    const wait = Number.isFinite(parsed) ? parsed * 1000 : FIXED_BACKOFF_MS;
    return Math.min(wait, RATE_LIMIT_CAP_MS);
  }
  return FIXED_BACKOFF_MS;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

export class LiveClaudeTransport implements NegotiationTransport {
  private readonly client: Anthropic;
  private readonly opts: LiveTransportOptions;

  constructor(opts: LiveTransportOptions = {}) {
    this.opts = opts;
    this.client = new Anthropic({
      maxRetries: 0, // we own retry + budget
      timeout: NEGOTIATION_WALL_BUDGET_MS,
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    });
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
          throw new Anthropic.InternalServerError(
            500,
            { message: "chaos" },
            "chaos",
            new Headers(),
          );
        }
        const resp = await this.client.messages.parse(
          {
            model: rendered.params.model,
            max_tokens: rendered.params.max_tokens,
            // temperature/top_p/top_k intentionally absent (removed on opus-5).
            thinking: { type: "adaptive", display: "summarized" },
            output_config: {
              effort: "medium",
              format: zodOutputFormat(NegotiationProposalZ),
            },
            system: rendered.system_blocks as Anthropic.TextBlockParam[],
            messages: msgs as Anthropic.MessageParam[],
          },
          {
            timeout: Math.min(FIRST_ATTEMPT_TIMEOUT_MS, Math.max(1, NEGOTIATION_WALL_BUDGET_MS - elapsed())),
            maxRetries: 0,
          },
        );
        const attempt: AttemptLog = {
          kind,
          latency_ms: Date.now() - a0,
          error_class: null,
          status: null,
          usage: resp.usage
            ? {
                input_tokens: resp.usage.input_tokens,
                output_tokens: resp.usage.output_tokens,
                cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? undefined,
              }
            : null,
        };
        const raw =
          resp.content
            ?.filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n") ?? "";
        const think =
          resp.content
            ?.filter(
              (b): b is Anthropic.ThinkingBlock =>
                b.type === "thinking" && typeof b.thinking === "string",
            )
            .map((b) => b.thinking)
            .join("\n") ?? "";
        return {
          ok: true,
          result: {
            parsed_output: (resp.parsed_output ?? null) as NegotiationProposal | null,
            raw_text: raw,
            thinking_summary: think,
            usage: attempt.usage,
            stop_reason: resp.stop_reason ?? "unknown",
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
