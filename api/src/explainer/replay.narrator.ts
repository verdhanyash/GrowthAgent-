/**
 * DEMO_STABLE_MODE ports for narration. Keyed by
 * sha256(canonicalJson(requestBody)); cache miss throws LOUDLY — never a
 * silent live call.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  NarrativeOutputZ,
  type NarrativeOutput,
} from "@growthagent/shared";
import type { NarrateArgs } from "./prompts.js";
import {
  NARRATOR_MODEL,
  buildRequestBody,
  requestBodyKey,
} from "./prompts.js";
import type { NarratorPort } from "./narrator.port.js";

export class StableModeCacheMissError extends Error {
  constructor(readonly key: string) {
    super(
      `DEMO_STABLE_MODE cache miss for narration key ${key} — record it first ` +
        `(run once with recording enabled against live), or disable stable mode`,
    );
    this.name = "StableModeCacheMissError";
  }
}

function argsKey(args: NarrateArgs): string {
  return requestBodyKey(buildRequestBody(args, NARRATOR_MODEL));
}

export class ReplayNarratorPort implements NarratorPort {
  constructor(private readonly recordingsDir: string) {}

  async narrate(args: NarrateArgs): Promise<NarrativeOutput> {
    const key = argsKey(args);
    let raw: string;
    try {
      raw = await readFile(`${this.recordingsDir}/${key}.json`, "utf8");
    } catch {
      throw new StableModeCacheMissError(key);
    }
    return NarrativeOutputZ.parse(JSON.parse(raw));
  }
}

export class RecordingNarratorPort implements NarratorPort {
  constructor(
    private readonly delegate: NarratorPort,
    private readonly recordingsDir: string,
  ) {}

  async narrate(args: NarrateArgs): Promise<NarrativeOutput> {
    const out = await this.delegate.narrate(args);
    const path = `${this.recordingsDir}/${argsKey(args)}.json`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(out, null, 2), "utf8");
    return out;
  }
}
