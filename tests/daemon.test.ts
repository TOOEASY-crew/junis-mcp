// tests/daemon.test.ts — launchd plist / systemd unit / schtasks builders (pure, nothing is installed)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildLaunchdPlist, buildSystemdUnit, buildSchtasksCreateCommand } from "../src/cli/daemon.js";

const node = "/usr/local/bin/node";
const script = "/Users/me/.npm/_npx/abc/node_modules/junis/dist/cli/index.js";
const log = "/Users/me/.junis/logs/junis.log";

describe("buildLaunchdPlist", () => {
  test("contains the program arguments, env and log paths", () => {
    const plist = buildLaunchdPlist({ nodePath: node, scriptPath: script, logFile: log, env: { HOME: "/Users/me", PATH: "/usr/bin:/bin" } });
    assert.match(plist, /<string>ai\.junis<\/string>/);
    assert.match(plist, new RegExp(`<string>${node}</string>`));
    assert.match(plist, /<string>start<\/string>\s*<string>--daemon<\/string>/);
    assert.match(plist, /<key>HOME<\/key>\s*<string>\/Users\/me<\/string>/);
    assert.match(plist, new RegExp(`<string>${log}</string>`));
    assert.doesNotMatch(plist, /JUNIS_API_URL/, "no URL env unless given");
  });

  test("values are XML-escaped so a crafted env or path cannot inject plist keys", () => {
    const plist = buildLaunchdPlist({
      nodePath: node,
      scriptPath: "/tmp/a b/<x>&y.js",
      logFile: log,
      env: { HOME: "/Users/me", PATH: "/usr/bin", JUNIS_API_URL: 'https://example.junis.ai/?q="1"&r=<2>' },
    });
    assert.match(plist, /<string>\/tmp\/a b\/&lt;x&gt;&amp;y\.js<\/string>/);
    assert.match(plist, /<key>JUNIS_API_URL<\/key>\s*<string>https:\/\/example\.junis\.ai\/\?q=&quot;1&quot;&amp;r=&lt;2&gt;<\/string>/);
    assert.doesNotMatch(plist, /<string>[^<]*<\/string>[^<]*<key>injected/);
    assert.equal((plist.match(/<key>/g) ?? []).length, (plist.match(/<\/key>/g) ?? []).length);
  });
});

describe("buildSystemdUnit", () => {
  test("quotes Environment= values and escapes quotes/backslashes", () => {
    const unit = buildSystemdUnit({
      nodePath: node,
      scriptPath: script,
      logFile: log,
      env: { HOME: "/home/me", PATH: "/usr/bin:/bin", JUNIS_API_URL: 'https://example.junis.ai/?a="b"\\c' },
    });
    assert.match(unit, /^ExecStart=\/usr\/local\/bin\/node \/Users\/me\/.*index\.js start --daemon$/m);
    assert.match(unit, /^Environment="HOME=\/home\/me"$/m);
    assert.match(unit, /^Environment="PATH=\/usr\/bin:\/bin"$/m);
    assert.match(unit, /^Environment="JUNIS_API_URL=https:\/\/example\.junis\.ai\/\?a=\\"b\\"\\\\c"$/m);
    assert.doesNotMatch(unit, /\n\n\n/, "no blank lines left by missing env vars");
    assert.match(unit, /StandardOutput=append:/);
  });

  test("a newline in a value cannot add directives", () => {
    const unit = buildSystemdUnit({ nodePath: node, scriptPath: script, logFile: log, env: { HOME: "/h", PATH: "/p", JUNIS_WS_URL: "wss://x.junis.ai\nExecStartPre=/bin/evil" } });
    assert.doesNotMatch(unit, /^ExecStartPre=/m);
  });
});

describe("buildSchtasksCreateCommand", () => {
  test("runs with limited privileges and quotes both paths", () => {
    const cmd = buildSchtasksCreateCommand({ nodePath: "C:\\Program Files\\nodejs\\node.exe", scriptPath: "C:\\Users\\me\\AppData\\junis\\dist\\cli\\index.js" });
    assert.match(cmd, /\/RL LIMITED/);
    assert.doesNotMatch(cmd, /HIGHEST/);
    assert.match(cmd, /\/TR "\\"C:\\Program Files\\nodejs\\node\.exe\\" \\"C:\\Users\\me\\AppData\\junis\\dist\\cli\\index\.js\\" start --daemon"/);
    assert.match(cmd, /\/SC ONLOGON/);
  });
});
