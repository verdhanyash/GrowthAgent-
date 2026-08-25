/**
 * DEMO_STABLE_MODE ports (campaign.md §7.3 tail).
 *
 * ReplayRationalePort: serves recorded rationales keyed by
 * sha256(canonicalJson(requestBody)) — the SAME hash the recorder used. A
 * cache miss throws LOUDLY (StableModeCacheMissError); it must never silently
 * fall through to a live call, because stable mode's whole contract is
 * byte-identical demo behavior without network access.
 *
 * RecordingRationalePort: wraps any delegate (the live port in practice) and
 * persists parsed_output under <recordingsDir>/<key>.json after success.
 * Because the request body embeds the entries (whose ids derive from the data
 * fingerprint), identical data replays identically; edited seed data forces
 * exactly one live re-record.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  RationalesOutputZ,
  type RationalesOutput,
} from "@growthagent/shared";
import type { RationalePort } from "./rationale.port.js";
import type { DraftArgs } from "./prompts.js";
import { buildRequestBody, requestBodyKey } from "./prompts.js";
import { CAMPAIGN_CONFIG } from "@growthagent/shared";

export class StableModeCacheMissError extends Error {
  constructor(readonly key: string) {
    super(
      `DEMO_STABLE_MODE cache miss for rationale key ${key} — record it first ` +
        `(run once with recording enabled against live), or disable stable mode`,
    );
    this.name = "StableModeCacheMissError";
  }
}

function argsKey(args: DraftArgs): string {
  return requestBodyKey(
    buildRequestBody(args, CAMPAIGN_CONFIG.rationaleModel),
  );
}

export class ReplayRationalePort implements RationalePort {
  constructor(private readonly recordingsDir: string) {}

  async draft(args: DraftArgs): Promise<RationalesOutput> {
    const key = argsKey(args);
    let raw: string;
    try {
      raw = await readFile(`${this.recordingsDir}/${key}.json`, "utf8");
    } catch {
      throw new StableModeCacheMissError(key);
    }
    return RationalesOutputZ.parse(JSON.parse(raw));
  }
}

export class RecordingRationalePort implements RationalePort {
  constructor(
    private readonly delegate: RationalePort,
    private readonly recordingsDir: string,
  ) {}

  async draft(args: DraftArgs): Promise<RationalesOutput> {
    const out = await this.delegate.draft(args);
    const path = `${this.recordingsDir}/${argsKey(args)}.json`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(out, null, 2), "utf8");
    return out;
  }
}
