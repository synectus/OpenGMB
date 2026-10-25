import { createServer, connect } from "node:net";
import { describe, expect, it } from "vitest";

// Canary for vitest.setup.ts: the guard is installed in every test process.
describe("test network guard", () => {
  it("refuses a public address at once and records it", async () => {
    const before = ((globalThis as { __blockedPublicConnects?: string[] }).__blockedPublicConnects ?? []).length;
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      connect({ host: "3.3.3.3", port: 443 }).on("error", resolve);
    });
    expect(err.code).toBe("ENETUNREACH");
    const list = (globalThis as { __blockedPublicConnects?: string[] }).__blockedPublicConnects ?? [];
    expect(list.length).toBe(before + 1);
    expect(list.at(-1)).toBe("3.3.3.3");
  });

  it("still allows loopback", async () => {
    const server = createServer((s) => s.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const data = await new Promise<string>((resolve, reject) => {
      const c = connect({ host: "127.0.0.1", port });
      let buf = "";
      c.on("data", (d) => (buf += d)).on("end", () => resolve(buf)).on("error", reject);
    });
    server.close();
    expect(data).toBe("ok");
  });
});

describe("test network guard, hostnames", () => {
  it("refuses a name that resolves to a public address (checked after the lookup)", async () => {
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      connect({
        host: "somewhere.example.com",
        port: 443,
        lookup: ((_n: string, _o: unknown, cb: (e: null, a: string, f: number) => void) => cb(null, "3.3.3.3", 4)) as never,
      }).on("error", resolve);
    });
    expect(err.code).toBe("ENETUNREACH");
    expect((globalThis as { __blockedPublicConnects?: string[] }).__blockedPublicConnects).toContain("3.3.3.3");
  });
});
