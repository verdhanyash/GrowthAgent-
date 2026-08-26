/**
 * Settlement configuration — provider selection is EXPLICIT and boot-asserted,
 * never presence-based (ARCHITECTURE.md §6.6; .env.example). Boot fails CLOSED
 * on inconsistency, printing BOTH signals:
 *   - MOCK requires keys to be ABSENT;
 *   - TEST_MODE requires key id matching ^rzp_test_[A-Za-z0-9]+$ (no
 *     placeholder runs like rzp_test_XXXXXXXXXXXX) plus a non-empty secret.
 * Tunables default per settlement.md §13; malformed numeric values refuse boot
 * rather than silently falling back.
 */
import { createHash } from "node:crypto";

export type ProviderMode = "MOCK" | "TEST_MODE";

/** Dev-only fallback so the zero-config MOCK demo boots; loudly named. */
export const MOCK_DEV_WEBHOOK_SECRET = "ga-mock-webhook-secret-dev-only";

export interface SettlementConfig {
  readonly providerMode: ProviderMode;
  /** Armed adapter kind stamped into every audit event + orders row (§6.6). */
  readonly provider: "mock" | "razorpay";
  readonly keyId: string | null;
  readonly keySecret: string | null;
  /** Scrub-safe fingerprint of the armed credential for the audit genesis. */
  readonly keyFingerprint: string;
  /** [current, ...rotation] — old payloads validate only against the old
   *  secret during a rotation window (V7). */
  readonly webhookSecrets: readonly string[];
  readonly webhookFreshnessSec: number;
  readonly reservationTtlMs: number;
  readonly lateCaptureGraceMs: number;
  readonly sweepIntervalMs: number;
  readonly idempotencyTtlMs: number;
  readonly webhookResponseBudgetMs: number;
  readonly chaosForceGatewayError: boolean;
  readonly demoStableMode: boolean;
}

export class SettlementConfigError extends Error {}

const KEY_ID_PATTERN = /^rzp_test_[A-Za-z0-9]+$/;

function isPlaceholderKeyId(keyId: string): boolean {
  // rzp_test_XXXXXXXXXXXX-style example values: the whole tail one repeated char.
  const tail = keyId.slice("rzp_test_".length);
  return tail.length > 0 && /^(.)\1+$/.test(tail);
}

function readInt(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new SettlementConfigError(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/**
 * Pure function of an env record — tests pass synthetic envs; production passes
 * process.env. Throws SettlementConfigError listing every failed signal.
 */
export function loadSettlementConfig(
  env: Readonly<Record<string, string | undefined>>,
): SettlementConfig {
  const failures: string[] = [];

  const isProduction = env["NODE_ENV"] === "production";
  const rawProvider = env["RAZORPAY_PROVIDER"];
  const providerUnset = rawProvider === undefined || rawProvider === "";
  // Fail CLOSED in production: an unset provider silently means MOCK, which in
  // turn arms MOCK_DEV_WEBHOOK_SECRET — a committed dev secret. Never in prod.
  if (providerUnset && isProduction) {
    failures.push(
      "RAZORPAY_PROVIDER must be set explicitly in production " +
        "(refusing to default to MOCK, which arms a committed dev webhook secret)",
    );
  }
  const providerMode: ProviderMode | null =
    providerUnset
      ? "MOCK" // default MOCK when unset (§6.6) — non-production only; prod fails above
      : rawProvider === "MOCK" || rawProvider === "TEST_MODE"
        ? rawProvider
        : null;
  if (providerMode === null) {
    failures.push(`RAZORPAY_PROVIDER="${rawProvider as string}" is not one of MOCK|TEST_MODE`);
  }

  const keyId = env["RAZORPAY_KEY_ID"]?.trim() ?? "";
  const keySecret = env["RAZORPAY_KEY_SECRET"]?.trim() ?? "";
  const keyPresent = keyId !== "" || keySecret !== "";

  if (providerMode === "MOCK" && keyPresent) {
    failures.push(
      `RAZORPAY_PROVIDER=MOCK requires Razorpay keys to be ABSENT but found ` +
        `key_id_present=${keyId !== ""} key_secret_present=${keySecret !== ""}`,
    );
  }
  if (providerMode === "TEST_MODE") {
    if (keyId === "" || keySecret === "") {
      failures.push(
        `RAZORPAY_PROVIDER=TEST_MODE requires both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET ` +
          `(key_id_present=${keyId !== ""}, key_secret_present=${keySecret !== ""})`,
      );
    } else {
      if (!KEY_ID_PATTERN.test(keyId)) {
        failures.push(`RAZORPAY_KEY_ID "${keyId}" does not match ^rzp_test_[A-Za-z0-9]+$`);
      } else if (isPlaceholderKeyId(keyId)) {
        failures.push(`RAZORPAY_KEY_ID "${keyId}" is a placeholder/example value`);
      }
    }
  }

  const webhookSecret = env["RAZORPAY_WEBHOOK_SECRET"]?.trim() ?? "";
  if (providerMode === "TEST_MODE" && webhookSecret === "") {
    failures.push("RAZORPAY_WEBHOOK_SECRET is required in TEST_MODE (V7 HMAC key)");
  }
  const oldWebhookSecret = env["OLD_WEBHOOK_SECRET"]?.trim() ?? "";
  const webhookSecrets =
    webhookSecret !== ""
      ? oldWebhookSecret !== ""
        ? [webhookSecret, oldWebhookSecret]
        : [webhookSecret]
      : [MOCK_DEV_WEBHOOK_SECRET];

  let freshnessSec = 0;
  let reservationTtlMs = 0;
  let lateCaptureGraceMs = 0;
  let sweepIntervalMs = 0;
  let idempotencyTtlMs = 0;
  let webhookResponseBudgetMs = 0;
  try {
    freshnessSec = readInt(env, "WEBHOOK_FRESHNESS_SEC", 300);
    reservationTtlMs = readInt(env, "RESERVATION_TTL_MS", 900_000);
    lateCaptureGraceMs = readInt(env, "LATE_CAPTURE_GRACE_MS", 300_000);
    sweepIntervalMs = readInt(env, "SWEEP_INTERVAL_MS", 30_000);
    idempotencyTtlMs = readInt(env, "IDEMPOTENCY_TTL_MS", 86_400_000);
    webhookResponseBudgetMs = readInt(env, "WEBHOOK_RESPONSE_BUDGET_MS", 4_000);
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
  }

  if (failures.length > 0) {
    throw new SettlementConfigError(
      `settlement boot refused (fail-closed):\n  - ${failures.join("\n  - ")}`,
    );
  }

  const resolvedMode: ProviderMode = providerMode === "TEST_MODE" ? "TEST_MODE" : "MOCK";
  const finalKeyId = resolvedMode === "TEST_MODE" && keyId !== "" ? keyId : null;
  const finalKeySecret = resolvedMode === "TEST_MODE" && keySecret !== "" ? keySecret : null;

  return Object.freeze({
    providerMode: resolvedMode,
    provider: resolvedMode === "TEST_MODE" ? ("razorpay" as const) : ("mock" as const),
    keyId: finalKeyId,
    keySecret: finalKeySecret,
    keyFingerprint:
      createHash("sha256").update(finalKeySecret ?? "mock").digest("hex").slice(0, 8),
    webhookSecrets: Object.freeze(webhookSecrets),
    webhookFreshnessSec: freshnessSec,
    reservationTtlMs,
    lateCaptureGraceMs,
    sweepIntervalMs,
    idempotencyTtlMs,
    webhookResponseBudgetMs,
    chaosForceGatewayError: env["CHAOS_FORCE_GATEWAY_ERROR"] === "1",
    demoStableMode: env["DEMO_STABLE_MODE"] === "true",
  });
}
