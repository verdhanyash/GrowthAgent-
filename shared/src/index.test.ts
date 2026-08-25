import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE_VERSION } from "./index.js";

describe("M0 toolchain smoke", () => {
  it("runs vitest against TS sources through the workspace", () => {
    expect(SHARED_PACKAGE_VERSION).toBe("0.1.0");
  });
});
