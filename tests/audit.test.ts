// tests/audit.test.ts — local audit log ~/.junis/logs/audit.jsonl: one JSON line per mutating call, 0600, 5MB rotation,
// never file contents / command output, JUNIS_AUDIT_LOG=0 opt-out, never throws.
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "junis-audit-test-"));
const originalHome = process.env.HOME;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type AuditModule = typeof import("../src/server/audit.js");
let audit: AuditModule;
const logFile = path.join(tmpHome, ".junis", "logs", "audit.jsonl");

before(async () => {
  audit = await import("../src/server/audit.js");
});
after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(tmpHome, ".junis"), { recursive: true, force: true });
  delete process.env.JUNIS_AUDIT_LOG;
});

describe("auditLog", () => {
  test("appends one JSON line with tool, args, ts, outcome; file and dir are owner-only", { skip: process.platform === "win32" }, () => {
    audit.auditLog({ tool: "execute_command", args: "ls -la", outcome: "ok" });
    audit.auditLog({ tool: "write_file", args: "/tmp/x.txt", outcome: "error", detail: "EACCES" });
    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.tool, "execute_command");
    assert.equal(first.args, "ls -la");
    assert.equal(first.outcome, "ok");
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(JSON.parse(lines[1]).detail, "EACCES");
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(logFile)).mode & 0o777, 0o700);
  });

  test("args are truncated to 200 characters and newlines are kept out of the line", () => {
    audit.auditLog({ tool: "execute_command", args: "x".repeat(500) + "\nsecond", outcome: "ok" });
    const line = fs.readFileSync(logFile, "utf-8").trim();
    assert.equal(line.split("\n").length, 1);
    const entry = JSON.parse(line);
    assert.ok(entry.args.length <= 200, String(entry.args.length));
  });

  test("rotates to .1 when the file exceeds 5MB", () => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, "x".repeat(5 * 1024 * 1024 + 1));
    audit.auditLog({ tool: "kill_process", args: "pid=1", outcome: "ok" });
    assert.ok(fs.existsSync(logFile + ".1"));
    const fresh = fs.readFileSync(logFile, "utf-8").trim().split("\n");
    assert.equal(fresh.length, 1);
    assert.equal(JSON.parse(fresh[0]).tool, "kill_process");
  });

  test("JUNIS_AUDIT_LOG=0 disables logging", () => {
    process.env.JUNIS_AUDIT_LOG = "0";
    audit.auditLog({ tool: "execute_command", args: "ls", outcome: "ok" });
    assert.equal(fs.existsSync(logFile), false);
  });

  test("never throws, even when the log directory cannot be created", () => {
    fs.mkdirSync(path.join(tmpHome, ".junis"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, ".junis", "logs"), "not a dir"); // blocks mkdir
    assert.doesNotThrow(() => audit.auditLog({ tool: "execute_command", args: "ls", outcome: "ok" }));
  });
});

describe("summarizeArgs", () => {
  test("never includes file contents or command output", () => {
    assert.equal(audit.summarizeArgs("write_file", { path: "/tmp/a.txt", content: "SECRET BODY" }), "/tmp/a.txt");
    assert.equal(audit.summarizeArgs("edit_block", { path: "/tmp/a.txt", old_string: "SECRET", new_string: "SECRET2" }), "/tmp/a.txt");
    assert.equal(audit.summarizeArgs("execute_command", { command: "echo hi", background: true }), "echo hi (background)");
    assert.equal(audit.summarizeArgs("kill_process", { pid: 42, signal: "SIGKILL" }), "pid=42 signal=SIGKILL");
    assert.equal(audit.summarizeArgs("cron_create", { schedule: "* * * * *", command: "backup.sh", label: "b" }), "* * * * * backup.sh (b)");
    assert.equal(audit.summarizeArgs("share_file", { path: "/tmp/r.pdf" }), "/tmp/r.pdf");
    assert.equal(audit.summarizeArgs("browser_upload", { ref: "e3", paths: ["/a", "/b"] }), "ref=e3 /a, /b");
    assert.ok(audit.summarizeArgs("execute_command", { command: "y".repeat(400) }).length <= 200);
  });

  test("policy-checked read tools log the path or URL, not just key names", () => {
    assert.equal(audit.summarizeArgs("list_directory", { path: "/tmp/d" }), "/tmp/d");
    assert.equal(audit.summarizeArgs("notebook_read", { path: "/tmp/n.ipynb" }), "/tmp/n.ipynb");
    assert.equal(audit.summarizeArgs("search_code", { pattern: "SECRET", directory: "/tmp/d", file_pattern: "**/*" }), "directory=/tmp/d");
    assert.equal(audit.summarizeArgs("browser_navigate", { url: "file:///tmp/x" }), "file:///tmp/x");
  });
});
