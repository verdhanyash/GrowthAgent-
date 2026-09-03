/**
 * api/src/http/admin-rules.route.ts — endpoint inventory rows 6–8 (§7.1):
 *   GET  /v1/admin/rules          — current MerchantRules + rules_version
 *   PUT  /v1/admin/rules          — patch rules; bumps rules_version monotonically
 *   GET  /v1/admin/rules/history  — versioned rules history
 *
 * Rules are INSERT-ONLY in Postgres: each PUT creates a new version row. The
 * current rules are always the highest-versioned row. In-flight transactions
 * are untouched — each pins its version at gate entry (E-09), which is exactly
 * what makes "change rules live, next tx behaves differently" a clean demo beat.
 *
 * A PUT that RAISES any guarded limit requires `confirm_increase:true` and
 * enforces a 15-minute cooldown between consecutive raises of the same field.
 * Every raise emits an audit event tagged `increase:true`.
 *
 * The composition root seeds MEERA_RULES_V3 into the DB on first boot when
 * the table is empty, and updates the in-memory `rules()` and `rulesVersion()`
 * closures on every successful PUT.
 */
import express, { type Router } from "express";
import {
  AdminRulesResponseSchema,
  PutRulesRequestSchema,
  RulesHistoryResponseSchema,
  MerchantRulesConfigSchema,
  HttpError,
  type MerchantRulesConfig,
} from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { asyncHandler } from "./errors.js";

export interface AdminRulesRoutesDeps {
  readonly db: PgPool;
  /** The ACTIVE rules. May be async: the composition root wires a read-through
   *  store so `expected_version` is compared against what Postgres holds, not a
   *  local cache — otherwise a PUT on replica A and a PUT on replica B both
   *  believe they hold the current version (audit H4). */
  readonly getCurrentRules: () => MerchantRulesConfig | Promise<MerchantRulesConfig>;
  /** Callback after a successful PUT — refreshes this replica's snapshot so the
   *  pipeline and gatekeeper see the new config immediately; other replicas
   *  pick it up on their next read-through. */
  readonly onRulesUpdated: (newRules: MerchantRulesConfig) => void;
}

/** Fields whose increase requires `confirm_increase:true` and a 15-min cooldown. */
const GUARDED_INCREASE_FIELDS = [
  "max_cart_value_paise",
  "max_discount_pct",
] as const;

/** Fields whose DECREASE requires confirmation (margin floor lowered = weaker protection). */
const GUARDED_DECREASE_FIELDS = [
  "margin_floor_pct",
] as const;

const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

/** Deep-merge a partial patch onto the current config. Only top-level keys in
 *  `patch` replace the current ones; nested objects (velocity, escalation_bands,
 *  etc.) are fully replaced if present in the patch. */
function mergeRules(
  current: MerchantRulesConfig,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, ...patch };
}

/** Detect if any guarded limit was raised (= weakened economically). */
function detectIncrease(
  before: MerchantRulesConfig,
  after: Record<string, unknown>,
): boolean {
  for (const field of GUARDED_INCREASE_FIELDS) {
    const bv = (before as Record<string, unknown>)[field];
    const av = after[field];
    if (typeof bv === "number" && typeof av === "number" && av > bv) return true;
  }
  for (const field of GUARDED_DECREASE_FIELDS) {
    const bv = (before as Record<string, unknown>)[field];
    const av = after[field];
    if (typeof bv === "number" && typeof av === "number" && av < bv) return true;
  }
  return false;
}

/** Compute the diff (advisory: what changed). */
function computeDiff(
  before: MerchantRulesConfig,
  after: MerchantRulesConfig,
): Record<string, unknown> {
  const beforeObj = before as unknown as Record<string, unknown>;
  const afterObj = after as unknown as Record<string, unknown>;
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])) {
    if (JSON.stringify(beforeObj[key]) !== JSON.stringify(afterObj[key])) {
      diff[key] = { before: beforeObj[key], after: afterObj[key] };
    }
  }
  return diff;
}

interface RulesRow {
  rules_version: number;
  rules_json: MerchantRulesConfig;
  actor: string;
  note: string | null;
  increase: boolean;
  diff: unknown;
  created_at: string;
}

export function adminRulesRoutes(deps: AdminRulesRoutesDeps): Router {
  const router = express.Router();

  // Row 6 — GET /v1/admin/rules: current config + version metadata.
  router.get(
    "/v1/admin/rules",
    asyncHandler(async (_req, res) => {
      const rules = await deps.getCurrentRules();
      // Try to get the DB row for updated_at; fall back to now.
      const r = await deps.db.query(
        `SELECT created_at FROM merchant_rules WHERE rules_version = $1`,
        [rules.rules_version],
      );
      const updatedAt =
        (r.rowCount ?? 0) > 0
          ? new Date((r.rows[0] as { created_at: string }).created_at).toISOString()
          : new Date().toISOString();

      res.status(200).json(
        AdminRulesResponseSchema.parse({
          rules,
          rules_version: rules.rules_version,
          updated_at: updatedAt,
        }),
      );
    }),
  );

  // Row 7 — PUT /v1/admin/rules: patch with optimistic concurrency.
  router.put(
    "/v1/admin/rules",
    express.json({ limit: "16kb" }),
    asyncHandler(async (req, res) => {
      const parsed = PutRulesRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, "VALIDATION_ERROR", "invalid rules update body", {
          details: parsed.error.issues,
          retryable: false,
        });
      }
      const { patch, expected_version, note, confirm_increase } = parsed.data;

      const current = await deps.getCurrentRules();

      // Optimistic concurrency: expected_version must match current.
      if (expected_version !== current.rules_version) {
        throw new HttpError(409, "RULES_VERSION_CONFLICT", "rules_version mismatch", {
          details: {
            expected: expected_version,
            actual: current.rules_version,
          },
          retryable: false,
        });
      }

      // Merge and validate the full config.
      const newVersion = current.rules_version + 1;
      const merged = mergeRules(current, patch);
      merged.rules_version = newVersion;
      merged.effective_from_iso = new Date().toISOString();

      const fullParsed = MerchantRulesConfigSchema.safeParse(merged);
      if (!fullParsed.success) {
        throw new HttpError(400, "VALIDATION_ERROR", "merged rules fail schema validation", {
          details: fullParsed.error.issues,
          retryable: false,
        });
      }
      const newRules = fullParsed.data;

      // Increase guard: detect if any guarded limit was raised.
      const isIncrease = detectIncrease(current, newRules as unknown as Record<string, unknown>);
      if (isIncrease && !confirm_increase) {
        throw new HttpError(
          409,
          "RULES_INCREASE_REQUIRES_CONFIRMATION",
          "this change raises a guarded limit; set confirm_increase:true to proceed",
          { retryable: false },
        );
      }

      // Cooldown: if this is a raise, check if the last raise on any guarded field was <15m ago.
      if (isIncrease) {
        const recent = await deps.db.query(
          `SELECT created_at FROM merchant_rules
             WHERE increase = true
             ORDER BY rules_version DESC LIMIT 1`,
        );
        if ((recent.rowCount ?? 0) > 0) {
          const lastRaise = new Date((recent.rows[0] as { created_at: string }).created_at).getTime();
          if (Date.now() - lastRaise < COOLDOWN_MS) {
            throw new HttpError(
              409,
              "RULES_INCREASE_COOLDOWN",
              "a raising change was applied less than 15 minutes ago",
              { retryable: false },
            );
          }
        }
      }

      const diff = computeDiff(current, newRules);

      // Insert the new version row. ON CONFLICT means a concurrent PUT raced us.
      try {
        await deps.db.query(
          `INSERT INTO merchant_rules (rules_version, rules_json, actor, note, increase, diff)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [newVersion, JSON.stringify(newRules), "admin-console", note ?? null, isIncrease, JSON.stringify(diff)],
        );
      } catch (err: unknown) {
        // Unique violation on rules_version → concurrent write.
        if (err instanceof Error && "code" in err && (err as { code: string }).code === "23505") {
          throw new HttpError(409, "RULES_VERSION_CONFLICT", "concurrent rules update; retry", {
            retryable: true,
          });
        }
        throw err;
      }

      // Update the in-memory rules so the pipeline sees the change immediately.
      deps.onRulesUpdated(newRules);

      // Respond with the updated rules.
      const body = AdminRulesResponseSchema.parse({
        rules: newRules,
        rules_version: newVersion,
        updated_at: new Date().toISOString(),
      });
      res.status(200).json(body);
    }),
  );

  // Row 8 — GET /v1/admin/rules/history: versioned changelog.
  router.get(
    "/v1/admin/rules/history",
    asyncHandler(async (_req, res) => {
      const r = await deps.db.query(
        `SELECT rules_version, actor, note, increase, diff, created_at
           FROM merchant_rules
          ORDER BY rules_version DESC`,
      );
      const history = (r.rows as RulesRow[]).map((row) => ({
        rules_version: row.rules_version,
        actor: row.actor,
        note: row.note,
        increase: row.increase,
        diff: row.diff,
        created_at: new Date(row.created_at).toISOString(),
      }));
      res.status(200).json(RulesHistoryResponseSchema.parse({ history }));
    }),
  );

  return router;
}
