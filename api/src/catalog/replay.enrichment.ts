/**
 * DEMO_STABLE_MODE ports for enrichment. Same contract as the campaign
 * rationale replay: keyed by sha256(canonicalJson(requestBody)); cache miss
 * throws LOUDLY — never a silent live call.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CATALOG_CONFIG,
  EnrichmentOutputZ,
  type EnrichmentOutput,
} from "@growthagent/shared";
import type { EnrichmentArgs, EnrichmentPort } from "./enrichment.port.js";
import { buildRequestBody, requestBodyKey } from "./prompts.js";

export class StableModeCacheMissError extends Error {
  constructor(readonly key: string) {
    super(
      `DEMO_STABLE_MODE cache miss for enrichment key ${key} — record it first ` +
        `(run once with recording enabled against live), or disable stable mode`,
    );
    this.name = "StableModeCacheMissError";
  }
}

function argsKey(args: EnrichmentArgs): string {
  return requestBodyKey(buildRequestBody(args, CATALOG_CONFIG.enrichmentModel));
}

export class ReplayEnrichmentPort implements EnrichmentPort {
  constructor(private readonly recordingsDir: string) {}

  async enrich(args: EnrichmentArgs): Promise<EnrichmentOutput> {
    const key = argsKey(args);
    let raw: string;
    try {
      raw = await readFile(`${this.recordingsDir}/${key}.json`, "utf8");
    } catch {
      throw new StableModeCacheMissError(key);
    }
    return EnrichmentOutputZ.parse(JSON.parse(raw));
  }
}

export class RecordingEnrichmentPort implements EnrichmentPort {
  constructor(
    private readonly delegate: EnrichmentPort,
    private readonly recordingsDir: string,
  ) {}

  async enrich(args: EnrichmentArgs): Promise<EnrichmentOutput> {
    const out = await this.delegate.enrich(args);
    const path = `${this.recordingsDir}/${argsKey(args)}.json`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(out, null, 2), "utf8");
    return out;
  }
}
