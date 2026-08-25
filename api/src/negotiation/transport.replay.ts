/**
 * ReplayTransport — DEMO_STABLE_MODE (negotiation.md §7). No network, EVER.
 * A missing fixture is a LOUD StableModeCacheMissError: presentation safety —
 * a surprise live network call mid-demo is worse than an error.
 *
 * Fixture key: sha256(canonicalJson({system_prompt_hash, pack_hash,
 * buyer_request_canonical})) → .demo-fixtures/negotiations/<key>.json.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NegotiationProposal } from "@growthagent/shared";
import { NegotiationProposalZ, canonicalJson } from "@growthagent/shared";
import {
  systemPromptHash,
  type RenderedRequest,
} from "./prompt.js";
import type {
  NegotiationTransport,
  TransportKeyInputs,
  TransportResult,
} from "./transport.types.js";

export class StableModeCacheMissError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(
      `DEMO_STABLE_MODE cache miss for negotiation fixture ${key} — record it via ` +
        `\`npm run demo:record -- --scenario <name>\`; replay NEVER falls back to live.`,
    );
    this.name = "StableModeCacheMissError";
    this.key = key;
  }
}

export function negotiationFixtureKey(inputs: TransportKeyInputs): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        system_prompt_hash: inputs.system_prompt_hash || systemPromptHash(),
        pack_hash: inputs.pack_hash,
        buyer_request_canonical: inputs.buyer_request_canonical,
      }),
      "utf8",
    )
    .digest("hex");
}

export interface ReplayTransportOptions {
  /** The negotiations fixture directory itself (defaults to
   *  <cwd>/.demo-fixtures/negotiations). Fixture files are <key>.json inside
   *  it. */
  readonly fixturesDir?: string | undefined;
}

interface NegotiationFixture {
  key: string;
  request_snapshot: unknown;
  raw_text: string;
  thinking_summary: string;
  parsed_output: NegotiationProposal;
  usage: TransportResult["usage"];
  stop_reason: string;
  latency_ms: number;
}

export class ReplayTransport implements NegotiationTransport {
  private readonly dir: string;

  constructor(opts: ReplayTransportOptions = {}) {
    this.dir = opts.fixturesDir ?? path.join(process.cwd(), ".demo-fixtures", "negotiations");
  }

  async execute(
    rendered: RenderedRequest,
    keyInputs: TransportKeyInputs,
  ): Promise<TransportResult> {
    const key = negotiationFixtureKey({
      ...keyInputs,
      system_prompt_hash: keyInputs.system_prompt_hash || systemPromptHash(),
    });
    let loaded: NegotiationFixture;
    try {
      const buf = await readFile(path.join(this.dir, `${key}.json`), "utf8");
      loaded = JSON.parse(buf) as NegotiationFixture;
    } catch {
      throw new StableModeCacheMissError(key);
    }

    // The stored proposal must STILL validate against the current schema —
    // a schema edit invalidates old fixtures loudly rather than silently.
    const parsed = NegotiationProposalZ.safeParse(loaded.parsed_output);
    if (!parsed.success) {
      throw new StableModeCacheMissError(`${key} (stored fixture failed current schema)`);
    }

    return Object.freeze({
      parsed_output: parsed.data,
      raw_text: loaded.raw_text ?? "",
      thinking_summary: loaded.thinking_summary ?? "",
      usage: loaded.usage ?? null,
      stop_reason: loaded.stop_reason ?? "end_turn",
      latency_ms: loaded.latency_ms ?? 0,
      attempts: Object.freeze([
        Object.freeze({
          kind: "initial" as const,
          latency_ms: loaded.latency_ms ?? 0,
          error_class: null,
          status: null,
          usage: loaded.usage ?? null,
        }),
      ]),
    });
  }
}
