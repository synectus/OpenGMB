import { describe, expect, it } from "vitest";
import { resolveScanCenter } from "./quick-scan-center";

describe("resolveScanCenter", () => {
  const locate = async (id: string) => (id === "ChIJknownplace01" ? { lat: 39.78, lng: -89.65 } : null);
  it("keeps coordinates the caller sent and never calls locate", async () => {
    const spy = async () => {
      throw new Error("must not be called");
    };
    expect(await resolveScanCenter("ChIJknownplace01", { centerLat: 1, centerLng: 2 }, spy)).toEqual({ lat: 1, lng: 2 });
  });
  it("looks the place up when coordinates are missing", async () => {
    expect(await resolveScanCenter("ChIJknownplace01", {}, locate)).toEqual({ lat: 39.78, lng: -89.65 });
  });
  it("refuses with INVALID_INPUT when the place cannot be located", async () => {
    await expect(resolveScanCenter("ChIJunknown00001", {}, locate)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("refuses with INVALID_INPUT when the lookup throws", async () => {
    const boom = async () => {
      throw new Error("timeout");
    };
    await expect(resolveScanCenter("ChIJknownplace01", {}, boom)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("refuses half a coordinate pair", async () => {
    await expect(resolveScanCenter("ChIJknownplace01", { centerLat: 1 }, locate)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
