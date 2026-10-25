import { describe, expect, it } from "vitest";
import { CORE_PLACEHOLDER } from "./index";

describe("core", () => {
  it("exports the placeholder", () => {
    expect(CORE_PLACEHOLDER).toBe("syngmb-core");
  });
});
