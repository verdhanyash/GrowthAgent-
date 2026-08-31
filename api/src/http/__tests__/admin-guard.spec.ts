/**
 * admin-guard.spec.ts — the §4.3 loopback + X-Admin-Token matrix, pure unit
 * (no Postgres). Drives requireAdmin() with fake req/res/next objects.
 */
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@growthagent/shared";
import { requireAdmin, resolveAllowInsecure } from "../admin-guard.js";

function fakeReq(remoteAddress: string, adminToken?: string) {
  return {
    socket: { remoteAddress },
    header: (name: string) =>
      name === "X-Admin-Token" ? adminToken : undefined,
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
