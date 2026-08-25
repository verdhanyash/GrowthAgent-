/**
 * CAMPAIGN_CONFIG — single source of truth for every campaign-orchestrator
 * knob (campaign.md §4). Imported by api + web; nothing may hardcode a
 * threshold found here elsewhere.
 */
export const CAMPAIGN_CONFIG = {
  // -- underselling
  velocityWindowDays: 28, // trailing window for units/day
  minHistoryDays: 14, // SKUs newer than this are excluded (launch ramp noise)
  minPeersPerGroup: 3, // category+band group must have >= this many SKUs for a peer median
  undersellRatioMax: 0.5, // flag when units_per_day / peer_median < this (STRICTLY less)
  coverWeeksMin: 4, // worth promoting only if stock cover >= this many weeks
  coverWeeksSentinel: 999, // cover value when units_per_day == 0

  // -- expiry risk
  expiryHorizonDays: 7, // expires_on within [as_of, as_of + horizon]
  expiryVelocityWindowDays: 14, // shorter window: recent velocity is what burns stock

  // -- attach mining
  attachWindowDays: 60,
  attachMinCoCount: 5, // absolute co-occurrence floor
  attachMinSupport: 0.03, // co_count / total_baskets
  attachMinConfidence: 0.15, // co_count / baskets_with_anchor_sku
  attachMaxPairs: 10,

  // -- timing
  patternWindowDays: 84, // 12 whole weeks
  timingMinLift: 1.8,
  timingMinCellUnits: 20, // (occasion,dow) cell must have >= this many units

  // -- set lifecycle
  maxEntriesPerSet: 8,
  prioritySetTtlSeconds: 6 * 3600, // FRESH window
  hardExpirySeconds: 48 * 3600, // past this, section omitted entirely
  refreshIntervalHours: 6,

  // -- scheduling / locking
  lockTtlMs: 5 * 60_000,

  // -- LLM
  rationaleModel: "claude-opus-5" as const,
  rationaleMaxTokens: 4096,
  rationaleTimeoutMs: 30_000,

  // -- rationale retry ladder (§7.3): the SDK client runs maxRetries: 0 so this
  // ladder is ours and test-visible. Sleep/jitter are injectable for tests.
  rationaleAttempts: 2,
  rationaleBackoffBaseMs: 500,
} as const;
