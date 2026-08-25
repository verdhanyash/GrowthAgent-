import { describe, expect, it } from "vitest";
import { greeting } from "./server.js";

describe("M0 toolchain smoke", () => {
  it("composes the shared package through workspace resolution", () => {
    expect(greeting()).toContain("growthagent api");
  });
});
