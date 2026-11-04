// tests/misc.test.ts — package version lookup, config redaction, peekaboo auto-install opt-out, IP geolocation mapping
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { VERSION, readPackageVersion } from "../src/server/version.js";
import { redactConfig } from "../src/cli/config.js";
import { shouldAutoInstall } from "../src/setup/peekaboo-installer.js";
import { IP_LOCATION_URL, formatIpLocation } from "../src/tools/device.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

describe("version", () => {
  test("VERSION equals package.json version (not a hard-coded 0.1.0)", () => {
    assert.equal(VERSION, pkg.version);
    assert.equal(readPackageVersion(), pkg.version);
    assert.notEqual(VERSION, "0.1.0");
  });
});

describe("redactConfig", () => {
  test("hides token-like fields and keeps the rest", () => {
    const out = redactConfig({ device_key: "dk", token: "eyJ.secret", device_name: "Mac", created_at: "t", local_host: "0.0.0.0", local_port: 3000, local_token: "abc" });
    assert.equal(out.token, "<redacted>");
    assert.equal(out.local_token, "<redacted>");
    assert.equal(out.device_key, "dk");
    assert.equal(out.device_name, "Mac");
    assert.equal(out.local_port, 3000);
    assert.doesNotMatch(JSON.stringify(out), /secret|abc/);
  });

  test("does not mutate its input and tolerates extra keys", () => {
    const input = { token: "t", api_token: "x", password: "p", other: 1 } as Record<string, unknown>;
    const out = redactConfig(input);
    assert.equal(input.token, "t");
    assert.equal(out.api_token, "<redacted>");
    assert.equal(out.password, "<redacted>");
    assert.equal(out.other, 1);
  });
});

describe("peekaboo shouldAutoInstall", () => {
  test("default on; JUNIS_NO_AUTO_INSTALL=1 turns it off", () => {
    assert.equal(shouldAutoInstall({}), true);
    assert.equal(shouldAutoInstall({ JUNIS_NO_AUTO_INSTALL: "1" }), false);
    assert.equal(shouldAutoInstall({ JUNIS_NO_AUTO_INSTALL: "true" }), false);
    assert.equal(shouldAutoInstall({ JUNIS_NO_AUTO_INSTALL: "0" }), true);
  });
});

describe("location_get IP fallback", () => {
  test("uses an https source and keeps the previous output shape", () => {
    assert.match(IP_LOCATION_URL, /^https:\/\//);
    const line = formatIpLocation({ latitude: 37.5, longitude: 127.0, city: "Seoul", country_name: "South Korea" });
    assert.equal(line, "Latitude: 37.5, Longitude: 127, City: Seoul, Country: South Korea (estimated via IP)");
    assert.throws(() => formatIpLocation({ error: true, reason: "RateLimited" }), /IP location lookup failed: RateLimited/);
    assert.throws(() => formatIpLocation({}), /IP location lookup failed/);
  });
});

describe("CLI help names the MCP server junis-device", () => {
  test("every `claude mcp add` example and the config snippet use junis-device, as the README does", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf-8");
    const adds = src.match(/claude mcp add [^\n]*/g) ?? [];
    assert.ok(adds.length >= 3);
    for (const line of adds) assert.match(line, /\bjunis-device\b/, line);
    assert.match(src, /"mcpServers": \{\s*"junis-device": \{/);
    assert.doesNotMatch(src, /"mcpServers": \{\s*"junis": \{/);
  });
});
