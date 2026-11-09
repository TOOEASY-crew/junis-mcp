// tests/local-settings.test.ts: precedence of --host/--port/--token over config fields, and token generation rules
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveLocalServerSettings, generateLocalToken, savedTokenFor } from "../src/server/local-settings.js";

const gen = () => "GENERATED";

describe("resolveLocalServerSettings", () => {
  test("defaults: 127.0.0.1:3000, no token, nothing to persist", () => {
    const r = resolveLocalServerSettings({}, {}, { generateToken: gen });
    assert.equal(r.host, "127.0.0.1");
    assert.equal(r.port, 3000);
    assert.equal(r.token, undefined);
    assert.equal(r.generated, false);
    assert.deepEqual(r.persist, {});
    assert.deepEqual(r.warnings, []);
  });

  test("flags win over config, config wins over defaults; given flags are persisted", () => {
    const r = resolveLocalServerSettings(
      { host: "192.168.0.10", port: 4000 },
      { local_host: "0.0.0.0", local_port: 5000, local_token: "saved" },
      { generateToken: gen }
    );
    assert.equal(r.host, "192.168.0.10");
    assert.equal(r.port, 4000);
    assert.equal(r.token, "saved");
    assert.equal(r.generated, false);
    assert.deepEqual(r.persist, { local_host: "192.168.0.10", local_port: 4000 });

    const fromConfig = resolveLocalServerSettings({}, { local_host: "0.0.0.0", local_port: 5000, local_token: "saved" }, { generateToken: gen });
    assert.equal(fromConfig.host, "0.0.0.0");
    assert.equal(fromConfig.port, 5000);
    assert.equal(fromConfig.token, "saved");
    assert.deepEqual(fromConfig.persist, {});
  });

  test("non-loopback host without a token generates one and persists it", () => {
    const r = resolveLocalServerSettings({ host: "0.0.0.0" }, {}, { generateToken: gen });
    assert.equal(r.token, "GENERATED");
    assert.equal(r.generated, true);
    assert.deepEqual(r.persist, { local_host: "0.0.0.0", local_token: "GENERATED" });
  });

  test("non-loopback host without a token and without a generator falls back to loopback with a warning (daemon)", () => {
    const r = resolveLocalServerSettings({}, { local_host: "0.0.0.0" }, {});
    assert.equal(r.host, "127.0.0.1");
    assert.equal(r.token, undefined);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /token/i);
    assert.deepEqual(r.persist, {});
  });

  test("--token on loopback is enforced and persisted; a saved token stays enforced on loopback", () => {
    const explicit = resolveLocalServerSettings({ token: "mine" }, {}, { generateToken: gen });
    assert.equal(explicit.host, "127.0.0.1");
    assert.equal(explicit.token, "mine");
    assert.deepEqual(explicit.persist, { local_token: "mine" });

    const saved = resolveLocalServerSettings({}, { local_token: "saved" }, { generateToken: gen });
    assert.equal(saved.token, "saved");
    assert.equal(saved.generated, false);
  });

  test("--no-token clears a saved token on loopback and is rejected on a non-loopback host", () => {
    const cleared = resolveLocalServerSettings({ token: false }, { local_token: "saved" }, { generateToken: gen });
    assert.equal(cleared.token, undefined);
    assert.deepEqual(cleared.persist, { local_token: null });

    assert.throws(
      () => resolveLocalServerSettings({ host: "0.0.0.0", token: false }, {}, { generateToken: gen }),
      /token/i
    );
  });

  test("invalid inputs are rejected", () => {
    assert.throws(() => resolveLocalServerSettings({ token: "" }, {}, { generateToken: gen }), /token/i);
    assert.throws(() => resolveLocalServerSettings({ token: "has space" }, {}, { generateToken: gen }), /token/i);
    assert.throws(() => resolveLocalServerSettings({ host: "http://x" }, {}, { generateToken: gen }), /host/i);
    assert.throws(() => resolveLocalServerSettings({ port: 0 }, {}, { generateToken: gen }), /port/i);
    assert.throws(() => resolveLocalServerSettings({ port: 70000 }, {}, { generateToken: gen }), /port/i);
    // Invalid values in config are ignored in favour of the defaults
    const r = resolveLocalServerSettings({}, { local_port: -5 as number, local_host: "" }, { generateToken: gen });
    assert.equal(r.port, 3000);
    assert.equal(r.host, "127.0.0.1");
  });

  test("relay mode (requireToken) on loopback without a saved token generates and persists one", () => {
    const gen = () => "GEN-RELAY";
    const r = resolveLocalServerSettings({}, {}, { generateToken: gen, requireToken: true });
    assert.equal(r.host, "127.0.0.1");
    assert.equal(r.token, "GEN-RELAY");
    assert.equal(r.generated, true);
    // its own key: local_token is shared with --local, which must stay token-optional on loopback
    assert.deepEqual(r.persist, { local_relay_token: "GEN-RELAY" });
  });
  test("a relay-generated token does not turn --local into a token-enforced server", () => {
    const saved = { local_relay_token: "GEN-RELAY" };
    const local = resolveLocalServerSettings({}, saved, { generateToken: () => "X" }); // --local: requireToken unset
    assert.equal(local.token, undefined);
    assert.deepEqual(local.persist, {});
    const relay = resolveLocalServerSettings({}, saved, { generateToken: () => "X", requireToken: true });
    assert.equal(relay.token, "GEN-RELAY");
    assert.equal(relay.generated, false);
    assert.deepEqual(relay.persist, {});
    const daemon = resolveLocalServerSettings({}, saved, { requireToken: true }); // daemon reads the same key
    assert.equal(daemon.token, "GEN-RELAY");
    assert.deepEqual(daemon.warnings, []);
  });
  test("an explicit local_token wins over the relay-generated one in relay mode", () => {
    const r = resolveLocalServerSettings({}, { local_token: "mine", local_relay_token: "GEN" }, { requireToken: true });
    assert.equal(r.token, "mine");
  });
  test("relay mode on a non-loopback host still saves the generated token as local_token", () => {
    const r = resolveLocalServerSettings({ host: "0.0.0.0" }, {}, { generateToken: () => "GEN-LAN", requireToken: true });
    assert.equal(r.token, "GEN-LAN");
    assert.deepEqual(r.persist, { local_host: "0.0.0.0", local_token: "GEN-LAN" });
  });
  test("relay mode keeps a saved token and persists nothing", () => {
    const r = resolveLocalServerSettings({}, { local_token: "saved" }, { generateToken: () => "X", requireToken: true });
    assert.equal(r.token, "saved");
    assert.deepEqual(r.persist, {});
  });
  test("relay daemon (no generator) without a saved token gets an ephemeral token and a warning", () => {
    const r = resolveLocalServerSettings({}, {}, { requireToken: true });
    assert.ok(typeof r.token === "string" && r.token.length >= 32);
    assert.deepEqual(r.persist, {});
    assert.ok(r.warnings.some((w) => /ephemeral|run npx junis/i.test(w)));
  });
  test("--no-token in relay mode is refused", () => {
    assert.throws(() => resolveLocalServerSettings({ token: false }, {}, { requireToken: true }), /relay mode/);
  });

  test("a non-loopback --local run reuses the relay token instead of minting a second one", () => {
    const saved = { local_host: "0.0.0.0", local_relay_token: "R" };
    const local = resolveLocalServerSettings({}, saved, { generateToken: () => "NEW" });
    assert.equal(local.token, "R");
    assert.equal(local.generated, false);
    assert.deepEqual(local.persist, {});
    const relay = resolveLocalServerSettings({}, saved, { generateToken: () => "NEW", requireToken: true });
    assert.equal(relay.token, "R");
  });

  test("savedTokenFor follows the server's own rules", () => {
    assert.deepEqual(savedTokenFor({ local_relay_token: "R" }, true), { token: "R", key: "local_relay_token" });
    assert.equal(savedTokenFor({ local_relay_token: "R" }, false), null); // --local does not use the relay token
    assert.deepEqual(savedTokenFor({ local_token: "L", local_relay_token: "R" }, true), { token: "L", key: "local_token" });
    // an invalid local_token is ignored by the server, so it must not hide the relay token that is actually used
    assert.deepEqual(savedTokenFor({ local_token: "", local_relay_token: "R" }, true), { token: "R", key: "local_relay_token" });
    assert.deepEqual(savedTokenFor({ local_token: "has space", local_relay_token: "R" }, true), { token: "R", key: "local_relay_token" });
    assert.equal(savedTokenFor({}, true), null);
  });

  test("generateLocalToken is base64url, 32 chars, unique", () => {
    const a = generateLocalToken();
    const b = generateLocalToken();
    assert.match(a, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(a, b);
  });
});
