// tests/logout.test.ts: logout order is revoke → stop daemon → unregister service → delete config (all stubbed)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runLogout, type LogoutDeps } from "../src/cli/logout.js";

function makeDeps(overrides: Partial<LogoutDeps> = {}): { deps: LogoutDeps; calls: string[]; lines: string[] } {
  const calls: string[] = [];
  const lines: string[] = [];
  const deps: LogoutDeps = {
    loadConfig: () => ({ device_key: "dev_1", token: "jwt_1" }),
    revokeDevice: async (deviceKey, token) => {
      calls.push(`revoke:${deviceKey}:${token}`);
      return { status: "revoked" };
    },
    stopDaemon: () => { calls.push("stopDaemon"); return true; },
    uninstallService: async () => { calls.push("uninstall"); },
    clearConfig: () => { calls.push("clearConfig"); },
    log: (line) => lines.push(line),
    ...overrides,
  };
  return { deps, calls, lines };
}

describe("runLogout", () => {
  test("order is revoke → stopDaemon → uninstall → clearConfig", async () => {
    const { deps, calls, lines } = makeDeps();
    const result = await runLogout(deps);
    assert.deepEqual(calls, ["revoke:dev_1:jwt_1", "stopDaemon", "uninstall", "clearConfig"]);
    assert.equal(result.revoke?.status, "revoked");
    assert.equal(result.daemonStopped, true);
    assert.ok(lines.some((l) => /revoked/i.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /cleared/i.test(l)), lines.join("\n"));
  });

  test("without credentials: no revoke call, still stops daemon, uninstalls and clears", async () => {
    const { deps, calls } = makeDeps({ loadConfig: () => null });
    const result = await runLogout(deps);
    assert.deepEqual(calls, ["stopDaemon", "uninstall", "clearConfig"]);
    assert.equal(result.revoke, null);
  });

  test("revoke not_supported / failed are reported in one line and do not stop the local cleanup", async () => {
    for (const status of ["not_supported", "failed"] as const) {
      const { deps, calls, lines } = makeDeps({
        revokeDevice: async () => ({ status, detail: "x" }),
      });
      await runLogout(deps);
      assert.deepEqual(calls, ["stopDaemon", "uninstall", "clearConfig"]);
      assert.equal(lines.filter((l) => /revoke|revoked|server/i.test(l)).length, 1, lines.join("\n"));
    }
  });

  test("a throwing revoke or uninstall never prevents clearConfig", async () => {
    const { deps, calls } = makeDeps({
      revokeDevice: async () => { throw new Error("unexpected"); },
      uninstallService: async () => { throw new Error("no service"); },
    });
    const result = await runLogout(deps);
    assert.deepEqual(calls, ["stopDaemon", "clearConfig"]);
    assert.equal(result.revoke?.status, "failed");
  });

  test("device_only is reported without claiming the token was revoked", async () => {
    const { deps, lines } = makeDeps({ revokeDevice: async () => ({ status: "device_only" }) });
    await runLogout(deps);
    const line = lines.find((l) => /server/i.test(l)) ?? "";
    assert.doesNotMatch(line, /token revoked/i, line);
    assert.match(line, /still valid|stays valid|until it expires/i, line);
  });
});
