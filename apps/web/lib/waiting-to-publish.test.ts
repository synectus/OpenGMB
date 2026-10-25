import { describe, expect, it } from "vitest";
import { waitingToPublishText } from "./waiting-to-publish";

describe("waitingToPublishText", () => {
  it("words one and many, and says why when writes are off", () => {
    expect(waitingToPublishText(1, false)).toBe("1 approved reply is waiting to publish.");
    expect(waitingToPublishText(2, false)).toBe("2 approved replies are waiting to publish.");
    expect(waitingToPublishText(1, true)).toContain("Google writes are off");
  });
});
