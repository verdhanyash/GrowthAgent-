/**
 * Clock seam (settlement.md §2): every time read in this subsystem goes
 * through it — MockProvider's simulated latency, webhook freshness checks,
 * TTL arithmetic. DEMO_STABLE_MODE swaps in VirtualClock and advances it
 * deterministically; nothing else in settlement may touch Date.now().
 */

export interface Clock {
  nowMs(): number;
  /** Resolves after `ms`. Under VirtualClock this only fires on advance(). */
  sleep(ms: number): Promise<void>;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

interface VirtualTimer {
  readonly at: number;
  resolve(): void;
}

/**
 * Deterministic clock for demos/tests: time stands still until advance() is
 * called; pending sleeps fire in due-order at their virtual deadlines.
 */
export class VirtualClock implements Clock {
  private t: number;
  private seq = 0;
  private readonly timers = new Map<number, VirtualTimer>();

  constructor(startMs = 1_700_000_000_000) {
    this.t = startMs;
  }

  nowMs(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    const id = ++this.seq;
    const at = this.t + ms;
    return new Promise<void>((resolve) => {
      this.timers.set(id, { at, resolve });
    });
  }

  /** Advance virtual time, firing every timer whose deadline passes, in
   *  deadline order, letting each continuation run (it may schedule more). */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let dueId: number | undefined;
      let due: VirtualTimer | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (due === undefined || timer.at < due.at)) {
          due = timer;
          dueId = id;
        }
      }
      if (due === undefined || dueId === undefined) break;
      this.timers.delete(dueId);
      if (due.at > this.t) this.t = due.at;
      due.resolve();
      await Promise.resolve(); // let the sleeper's continuation run
    }
    this.t = target;
  }
}

/** Epoch seconds for freshness/TTL math against provider timestamps. */
export function nowEpochSec(clock: Clock): number {
  return Math.floor(clock.nowMs() / 1000);
}
