import { describe, expect, it } from "vitest";
import { makeTimeFormat } from "./time-format";
import { tokenAccess, tokenCreated, tokenLastUsed, tokenStatus } from "./tokens-view";

const utcTf = makeTimeFormat({ zones: [], workspaceId: null });
const istTf = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

describe("token text", () => {
  it("access from scopes", () => {
    expect(tokenAccess(["read", "write"])).toBe("Read & write");
    expect(tokenAccess(["read"])).toBe("Read only");
  });

  it("status reads Active, or Revoked with the date (the smoke test looks for both words)", () => {
    expect(tokenStatus(null, utcTf)).toBe("Active");
    expect(tokenStatus("2026-10-10T23:30:00.000Z", utcTf)).toBe("Revoked 2026-10-10");
    expect(tokenStatus("2026-10-10T23:30:00.000Z", istTf)).toBe("Revoked 11/10/2026");
  });

  it("dates follow the client; last used carries the time", () => {
    expect(tokenCreated("2026-10-12T15:08:12.000Z", utcTf)).toBe("2026-10-12");
    expect(tokenCreated("2026-10-12T15:08:12.000Z", istTf)).toBe("12/10/2026");
    expect(tokenLastUsed("2026-10-18T09:40:00.000Z", utcTf)).toBe("2026-10-18 09:40");
    expect(tokenLastUsed("2026-10-18T09:40:00.000Z", istTf)).toBe("18/10/2026 15:10");
    expect(tokenLastUsed(null, utcTf)).toBe("Never");
  });
});
