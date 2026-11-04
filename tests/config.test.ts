// tests/config.test.ts: merging and preserving local_* fields in ~/.junis/config.json (HOME points to a temp folder; real files are untouched)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "junis-config-test-"));
const originalHome = process.env.HOME;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type ConfigModule = typeof import("../src/cli/config.js");
let cfg: ConfigModule;
const configFile = path.join(tmpHome, ".junis", "config.json");

before(async () => {
  cfg = await import("../src/cli/config.js");
});
after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const creds = { device_key: "dev_1", token: "jwt_1", device_name: "Test Mac", created_at: "2026-09-29T00:00:00.000Z" };

describe("config local_* fields", () => {
  test("module resolved the temp HOME (never the real ~/.junis)", () => {
    assert.ok(configFile.startsWith(tmpHome));
    assert.equal(fs.existsSync(configFile), false);
  });

  test("old 4-field config still loads; local settings are empty", () => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(creds));
    const loaded = cfg.loadConfig();
    assert.deepEqual(loaded, creds);
    assert.deepEqual(cfg.loadLocalServerSettings(), {});
  });

  test("saveLocalServerSettings merges into the file and keeps credentials; null deletes a key", () => {
    cfg.saveLocalServerSettings({ local_host: "0.0.0.0", local_port: 4000, local_token: "tok" });
    assert.deepEqual(cfg.loadLocalServerSettings(), { local_host: "0.0.0.0", local_port: 4000, local_token: "tok" });
    assert.equal(cfg.loadConfig()?.device_key, "dev_1");
    const mode = fs.statSync(configFile).mode & 0o777;
    assert.equal(mode, 0o600);

    cfg.saveLocalServerSettings({ local_token: null });
    assert.deepEqual(cfg.loadLocalServerSettings(), { local_host: "0.0.0.0", local_port: 4000 });
  });

  test("saveConfig (re-auth) preserves local_* fields it was not given", () => {
    cfg.saveConfig({ ...creds, token: "jwt_2" });
    const raw = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    assert.equal(raw.token, "jwt_2");
    assert.equal(raw.local_host, "0.0.0.0");
    assert.equal(raw.local_port, 4000);
  });

  test("clearConfig removes credentials but keeps local server settings; loadConfig is then null", () => {
    cfg.clearConfig();
    assert.equal(cfg.loadConfig(), null);
    assert.deepEqual(cfg.loadLocalServerSettings(), { local_host: "0.0.0.0", local_port: 4000 });
    cfg.saveLocalServerSettings({ local_host: null, local_port: null });
    assert.deepEqual(cfg.loadLocalServerSettings(), {});
    // With no keys left, the file itself is deleted
    cfg.clearConfig();
    assert.equal(fs.existsSync(configFile), false);
  });

  test("local settings can be saved without any credentials (--local users)", () => {
    cfg.saveLocalServerSettings({ local_host: "0.0.0.0", local_token: "t" });
    assert.equal(cfg.loadConfig(), null);
    assert.deepEqual(cfg.loadLocalServerSettings(), { local_host: "0.0.0.0", local_token: "t" });
    cfg.clearConfig();
  });

  test("malformed types in local_* are ignored", () => {
    fs.writeFileSync(configFile, JSON.stringify({ ...creds, local_port: "4000", local_host: 5, local_token: ["x"] }));
    assert.deepEqual(cfg.loadLocalServerSettings(), {});
  });
});

describe("config file permissions (owner only)", { skip: process.platform === "win32" }, () => {
  const configDir = path.dirname(configFile);
  const mode = (p: string) => fs.statSync(p).mode & 0o777;

  test("a fresh save creates ~/.junis 0700 and config.json 0600", () => {
    fs.rmSync(configDir, { recursive: true, force: true });
    cfg.saveConfig(creds);
    assert.equal(mode(configDir), 0o700);
    assert.equal(mode(configFile), 0o600);
  });

  test("an older install (0755 dir, 0644 file) is tightened on the next save", () => {
    fs.chmodSync(configDir, 0o755);
    fs.chmodSync(configFile, 0o644);
    cfg.saveLocalServerSettings({ local_port: 3100 });
    assert.equal(mode(configDir), 0o700);
    assert.equal(mode(configFile), 0o600);
    assert.equal(cfg.loadConfig()?.token, creds.token, "credentials kept");
  });

  test("secureConfigDir tightens an existing dir without writing config, and never throws", () => {
    fs.chmodSync(configDir, 0o755);
    cfg.secureConfigDir();
    assert.equal(mode(configDir), 0o700);
    fs.rmSync(configDir, { recursive: true, force: true });
    assert.doesNotThrow(() => cfg.secureConfigDir());
    assert.equal(fs.existsSync(configDir), false, "does not create the dir by itself");
  });
});
