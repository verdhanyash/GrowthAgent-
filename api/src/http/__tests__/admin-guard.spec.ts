/**
 * admin-guard.spec.ts — the §4.3 loopback + X-Admin-Token matrix, pure unit
 * (no Postgres). Drives requireAdmin() with fake req/res/next objects.
 */
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@growthagent/shared";
import { requireAdmin, resolveAllowInsecure } from "../admin-guard.js";

function fakeReq(
  remoteAddress: string,
  adminToken?: string,
  extraHeaders: Record<string, string> = {},
) {
  // Real express `req.header()` is case-insensitive; mirror that so the guard's
  // lowercase lookups see the headers a proxy would actually add.
  const lower = new Map(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    socket: { remoteAddress },
    header: (name: string) =>
      name === "X-Admin-Token" ? adminToken : lower.get(name.toLowerCase()),
  } as unknown as Parameters<ReturnType<typeof requireAdmin>>[0];
}

function run(mw: ReturnType<typeof requireAdmin>, req: ReturnType<typeof fakeReq>) {
  return new Promise<HttpError | null>((resolve) => {
    mw(req, {} as never, (err?: unknown) => resolve((err as HttpError) ?? null));
  });
}

describe("requireAdmin — auth matrix (§4.3/§11.1)", () => {
  const TOKEN = "s3cret-admin-token";

  it("loopback + correct token → passes", async () => {
    const err = await run(requireAdmin({ adminToken: TOKEN, allowInsecure: false }), fakeReq("127.0.0.1", TOKEN));
    expect(err).toBeNull();
  });

  it("accepts ::1 and ::ffff:127.0.0.1 as loopback", async () => {
    for (const addr of ["::1", "::ffff:127.0.0.1"]) {
      const err = await run(requireAdmin({ adminToken: TOKEN, allowInsecure: false }), fakeReq(addr, TOKEN));
      expect(err).toBeNull();
    }
  });

  it("off-loopback → 401 UNAUTHORIZED regardless of a correct token", async () => {
    const err = await run(requireAdmin({ adminToken: TOKEN, allowInsecure: true }), fakeReq("10.0.0.5", TOKEN));
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(401);
    expect(err?.code).toBe("UNAUTHORIZED");
  });

  it("loopback + wrong token, insecure OFF → 401", async () => {
    const err = await run(requireAdmin({ adminToken: TOKEN, allowInsecure: false }), fakeReq("127.0.0.1", "nope"));
    expect(err?.status).toBe(401);
  });

  it("loopback + missing token, insecure OFF → 401", async () => {
    const err = await run(requireAdmin({ adminToken: TOKEN, allowInsecure: false }), fakeReq("127.0.0.1", undefined));
    expect(err?.status).toBe(401);
  });

  it("loopback + missing token, insecure ON → passes with ONE loud warning", async () => {
    const warn = vi.fn();
    const mw = requireAdmin({ adminToken: TOKEN, allowInsecure: true, warn });
    expect(await run(mw, fakeReq("127.0.0.1", undefined))).toBeNull();
    expect(await run(mw, fakeReq("127.0.0.1", undefined))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1); // warns once, not per request
  });

  it("no token configured + insecure OFF → 401 (production posture)", async () => {
    const err = await run(requireAdmin({ adminToken: undefined, allowInsecure: false }), fakeReq("127.0.0.1", "anything"));
    expect(err?.status).toBe(401);
  });

  it("no token configured + insecure ON → passes (dev open)", async () => {
    const err = await run(requireAdmin({ adminToken: undefined, allowInsecure: true, warn: () => {} }), fakeReq("127.0.0.1", undefined));
    expect(err).toBeNull();
  });
});

describe("resolveAllowInsecure — NODE_ENV posture", () => {
  it("production forces false even when the flag says true", () => {
    expect(resolveAllowInsecure({ NODE_ENV: "production", ALLOW_INSECURE_ADMIN: "true" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("non-production defaults true", () => {
    expect(resolveAllowInsecure({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("non-production respects an explicit false/0", () => {
    expect(resolveAllowInsecure({ ALLOW_INSECURE_ADMIN: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveAllowInsecure({ ALLOW_INSECURE_ADMIN: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

/**
 * audit H1 — `isLoopback` reads `req.socket.remoteAddress`, which behind ANY
 * reverse proxy is the PROXY's address (routinely 127.0.0.1, or a container
 * bridge IP). Combined with the dev-default escape hatch, an internet-reachable
 * staging box handed anyone PUT /v1/admin/rules and POST /v1/demo/reset.
 */
describe("requireAdmin — proxied requests (audit H1)", () => {
  const TOKEN = "s3cret-admin-token";

  const FORWARDED = [
    "X-Forwarded-For",
    "x-forwarded-for",
    "X-Forwarded-Host",
    "X-Forwarded-Proto",
    "X-Real-IP",
    "X-Client-IP",
    "CF-Connecting-IP",
    "True-Client-IP",
    "Forwarded",
    "Via",
  ];

  it("refuses a loopback-looking request that carries ANY forwarding header", async () => {
    for (const header of FORWARDED) {
      const err = await run(
        requireAdmin({ adminToken: TOKEN, allowInsecure: true, warn: () => {} }),
        fakeReq("127.0.0.1", TOKEN, { [header]: "203.0.113.9" }),
      );
      expect(err, header).toBeInstanceOf(HttpError);
      expect(err?.status, header).toBe(401);
      expect(err?.code, header).toBe("UNAUTHORIZED");
    }
  });

  it("refuses even with the CORRECT token — no token oracle for proxied callers", async () => {
    const err = await run(
      requireAdmin({ adminToken: TOKEN, allowInsecure: false, warn: () => {} }),
      fakeReq("127.0.0.1", TOKEN, { "X-Forwarded-For": "127.0.0.1" }),
    );
    expect(err?.status).toBe(401);
  });

  it("warns once, not per request (a log flood is its own denial of service)", async () => {
    const warn = vi.fn();
    const mw = requireAdmin({ adminToken: TOKEN, allowInsecure: false, warn });
    for (let i = 0; i < 5; i++) {
      await run(mw, fakeReq("127.0.0.1", TOKEN, { "X-Forwarded-For": "10.0.0.1" }));
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an EMPTY forwarding header is not treated as a proxy hop", async () => {
    const err = await run(
      requireAdmin({ adminToken: TOKEN, allowInsecure: false }),
      fakeReq("127.0.0.1", TOKEN, { "X-Forwarded-For": "   " }),
    );
    expect(err).toBeNull();
  });

  it("a genuine loopback request with no forwarding headers still passes", async () => {
    const err = await run(
      requireAdmin({ adminToken: TOKEN, allowInsecure: false }),
      fakeReq("127.0.0.1", TOKEN),
    );
    expect(err).toBeNull();
  });
});

describe("resolveAllowInsecure — a configured ADMIN_TOKEN means enforce it (audit H1)", () => {
  it("defaults OFF when ADMIN_TOKEN is set and no flag was given", () => {
    expect(resolveAllowInsecure({ ADMIN_TOKEN: "tok" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("defaults ON when there is no token to enforce (zero-config demo)", () => {
    expect(resolveAllowInsecure({} as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveAllowInsecure({ ADMIN_TOKEN: "   " } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("an EXPLICIT flag still wins outside production", () => {
    expect(resolveAllowInsecure({ ADMIN_TOKEN: "tok", ALLOW_INSECURE_ADMIN: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveAllowInsecure({ ALLOW_INSECURE_ADMIN: "false" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("production forces it off however the env is written", () => {
    expect(
      resolveAllowInsecure({ NODE_ENV: "production", ADMIN_TOKEN: "tok", ALLOW_INSECURE_ADMIN: "1" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
