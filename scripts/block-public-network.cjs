/* eslint-disable -- a CommonJS preload (node --require), not application code */
// Test-only guard: no test process may open a TCP connection to a public address.
// Loopback, private ranges and the configured database hosts are allowed; anything else fails at once
// with ENETUNREACH and is recorded in globalThis.__blockedPublicConnects (a canary can read it).
const net = require("node:net");

const flag = Symbol.for("syngmb.blockPublicNetwork");
if (!net.Socket.prototype.connect[flag]) {
  const allowedHosts = new Set(["localhost", "0.0.0.0", "::1", "::"]);
  for (const k of ["DATABASE_URL", "DATABASE_URL_TEST"]) {
    try {
      if (process.env[k]) allowedHosts.add(new URL(process.env[k]).hostname.replace(/^\[|\]$/g, ""));
    } catch {}
  }
  const privateV4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;
  const allowed = (host) => allowedHosts.has(host) || host.endsWith(".localhost") || privateV4.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host);

  const record = (host) => (globalThis.__blockedPublicConnects ??= []).push(host);
  const refusal = (host) => Object.assign(new Error(`test network guard: refused ${host}`), { code: "ENETUNREACH" });

  const original = net.Socket.prototype.connect;
  const guarded = function (...args) {
    // net.connect() hands over Node's already-normalised [options, callback] array.
    const normalised = Array.isArray(args[0]);
    const o = normalised ? args[0][0] : args[0];
    const host = o && typeof o === "object" ? o.host : undefined;
    // A unix socket path (no host) and a missing host (defaults to localhost) are local.
    if (typeof host !== "string") return original.apply(this, args);
    if (net.isIP(host)) {
      if (allowed(host)) return original.apply(this, args);
      record(host);
      process.nextTick(() => this.destroy(refusal(host)));
      return this;
    }
    if (allowed(host)) return original.apply(this, args);
    // A name: check what it resolves to (the lookup runs inside connect), so a custom lookup is honoured.
    const inner = o.lookup || require("node:dns").lookup;
    const lookup = (name, opts, cb) => {
      if (typeof opts === "function") [opts, cb] = [{}, opts];
      inner(name, opts, (err, address, family) => {
        if (err) return cb(err, address, family);
        const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
        const bad = list.find((a) => !allowed(a));
        if (bad) {
          record(bad);
          return cb(refusal(bad));
        }
        cb(null, address, family);
      });
    };
    const patched = { ...o, lookup };
    // The normalised array is fresh per call, so it is safe to update in place (it carries a private symbol).
    if (normalised) args[0][0] = patched;
    else args[0] = patched;
    return original.apply(this, args);
  };
  guarded[flag] = true;
  net.Socket.prototype.connect = guarded;
}
