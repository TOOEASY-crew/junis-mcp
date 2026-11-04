// tests/filesystem-tools.test.ts — FilesystemTools through a real MCP client (in-memory transport):
// policy wiring, size cap, pid schema, rg argument order, temp files, audit entries.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "junis-fstools-test-"));
const originalHome = process.env.HOME;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type FsModule = typeof import("../src/tools/filesystem.js");
let fsTools: FsModule;
let client: Client;
const auditFile = path.join(tmpHome, ".junis", "logs", "audit.jsonl");

interface ToolResult { content: { type: string; text?: string }[]; isError?: boolean }
async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}
function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}

before(async () => {
  fsTools = await import("../src/tools/filesystem.js");
  const server = new McpServer({ name: "t", version: "0.0.0" });
  new fsTools.FilesystemTools().register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
});
after(async () => {
  await client.close();
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("pure helpers", () => {
  test("buildRgArgs puts user input after --", () => {
    const args = fsTools.buildRgArgs("-e evil", "--dir", "**/*");
    const sep = args.indexOf("--");
    assert.ok(sep > 0);
    assert.deepEqual(args.slice(sep), ["--", "-e evil", "--dir"]);
    assert.deepEqual(fsTools.buildRgArgs("x", ".", "*.ts").slice(0, 7), ["--no-heading", "-n", "--max-count", "200", "-g", "*.ts", "--"]);
  });

  test("maxFileBytes defaults to 50MB and honours JUNIS_MAX_FILE_MB", () => {
    assert.equal(fsTools.maxFileBytes({}), 50 * 1024 * 1024);
    assert.equal(fsTools.maxFileBytes({ JUNIS_MAX_FILE_MB: "2" }), 2 * 1024 * 1024);
    assert.equal(fsTools.maxFileBytes({ JUNIS_MAX_FILE_MB: "abc" }), 50 * 1024 * 1024);
    assert.equal(fsTools.maxFileBytes({ JUNIS_MAX_FILE_MB: "0" }), 50 * 1024 * 1024);
  });

  test("safeRegExp never throws on an invalid pattern (literal fallback)", () => {
    assert.equal(fsTools.safeRegExp("foo(").test("a foo( b"), true);
    assert.equal(fsTools.safeRegExp("fo+").test("FOOO"), true, "case-insensitive like before");
  });
});

describe("tools via MCP", () => {
  test("execute_command still works and is audited without its output", async () => {
    const r = await call("execute_command", { command: "echo hello-from-test" });
    assert.equal(r.isError, undefined);
    assert.match(text(r), /hello-from-test/);
    const entries = fs.readFileSync(auditFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const e = entries.find((x) => x.tool === "execute_command");
    assert.ok(e);
    assert.equal(e.args, "echo hello-from-test");
    assert.equal(e.outcome, "ok");
    assert.doesNotMatch(JSON.stringify(e), /hello-from-test"?\s*\n|stdout/);
  });

  test("execute_command background=true returns a PID and the process is detached", async () => {
    const r = await call("execute_command", { command: "sleep 0.2", background: true });
    assert.equal(r.isError, undefined);
    const m = text(r).match(/PID:?\s*(\d+)/i);
    assert.ok(m, text(r));
    assert.ok(Number(m![1]) > 0);
  });

  test("execute_command refuses a catastrophic command and audits it as denied", async () => {
    const r = await call("execute_command", { command: "rm -rf /" });
    assert.equal(r.isError, true);
    assert.match(text(r), /policy/i);
    const entries = fs.readFileSync(auditFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(entries.some((x) => x.tool === "execute_command" && x.outcome === "denied"));
  });

  test("read_file / share_file / edit_block refuse protected paths; ordinary files still work", async () => {
    const ssh = path.join(tmpHome, ".ssh");
    fs.mkdirSync(ssh, { recursive: true });
    fs.writeFileSync(path.join(ssh, "id_rsa"), "PRIVATE");
    const ok = path.join(tmpHome, "notes.txt");
    fs.writeFileSync(ok, "hello");

    for (const tool of ["read_file", "share_file"]) {
      const r = await call(tool, { path: path.join(ssh, "id_rsa") });
      assert.equal(r.isError, true, tool);
      assert.doesNotMatch(text(r), /PRIVATE/);
      assert.match(text(r), /policy/i);
    }
    const e = await call("edit_block", { path: path.join(ssh, "id_rsa"), old_string: "PRIVATE", new_string: "X" });
    assert.equal(e.isError, true);
    assert.equal(fs.readFileSync(path.join(ssh, "id_rsa"), "utf-8"), "PRIVATE");

    assert.equal(text(await call("read_file", { path: ok })), "hello");
    const shared = text(await call("share_file", { path: ok }));
    assert.match(shared, /^__SHARE__:notes\.txt:text\/plain; charset=utf-8:/);
    const edited = await call("edit_block", { path: ok, old_string: "hello", new_string: "bye" });
    assert.equal(edited.isError, undefined);
    assert.equal(fs.readFileSync(ok, "utf-8"), "bye");
  });

  test("read_file and share_file refuse files above the size cap with a clear message", async () => {
    process.env.JUNIS_MAX_FILE_MB = "1";
    try {
      const big = path.join(tmpHome, "big.bin");
      fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
      for (const tool of ["read_file", "share_file"]) {
        const r = await call(tool, { path: big });
        assert.equal(r.isError, true, tool);
        assert.match(text(r), /too large|exceeds|JUNIS_MAX_FILE_MB/i);
      }
    } finally {
      delete process.env.JUNIS_MAX_FILE_MB;
    }
  });

  test("kill_process rejects non-positive / non-integer PIDs at the schema", async () => {
    for (const pid of [-1, 0, 1.5]) {
      const r = await call("kill_process", { pid });
      assert.equal(r.isError, true, String(pid));
      assert.doesNotMatch(text(r), /killed/);
    }
  });

  test("write_file works and the audit line holds the path, never the content", async () => {
    const p = path.join(tmpHome, "out", "w.txt");
    const r = await call("write_file", { path: p, content: "TOP-SECRET-CONTENT" });
    assert.equal(r.isError, undefined);
    assert.equal(fs.readFileSync(p, "utf-8"), "TOP-SECRET-CONTENT");
    const log = fs.readFileSync(auditFile, "utf-8");
    assert.doesNotMatch(log, /TOP-SECRET-CONTENT/);
    assert.match(log, /"tool":"write_file"/);
  });

  test("a failed edit_block, share_file or kill_process is audited as error, without file text", async () => {
    const lastEntry = (tool: string) => {
      const entries = fs.readFileSync(auditFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      return entries.filter((e: { tool: string }) => e.tool === tool).pop();
    };
    const f = path.join(tmpHome, "edit-fail.txt");
    fs.writeFileSync(f, "KEEP-THIS-TEXT");
    const e = await call("edit_block", { path: f, old_string: "SEARCH-THAT-IS-MISSING", new_string: "NEW-TEXT" });
    assert.equal(e.isError, true);
    const edit = lastEntry("edit_block");
    assert.equal(edit.outcome, "error");
    assert.equal(edit.args, f);
    const missing = path.join(tmpHome, "no-such-file.txt");
    const m = await call("edit_block", { path: missing, old_string: "a", new_string: "b" });
    assert.equal(m.isError, true);
    assert.equal(lastEntry("edit_block").outcome, "error");

    const s = await call("share_file", { path: missing });
    assert.equal(s.isError, true);
    const share = lastEntry("share_file");
    assert.equal(share.outcome, "error");
    assert.equal(share.args, missing);

    // A PID above any pid_max: kill -9 (taskkill on Windows) fails.
    const k = await call("kill_process", { pid: 2147483000, signal: "SIGKILL" });
    assert.equal(k.isError, true);
    assert.equal(lastEntry("kill_process").outcome, "error");

    const log = fs.readFileSync(auditFile, "utf-8");
    for (const secret of ["KEEP-THIS-TEXT", "SEARCH-THAT-IS-MISSING", "NEW-TEXT"]) assert.doesNotMatch(log, new RegExp(secret));
  });

  test("search_code finds text in files (rg or glob fallback) with a pattern that starts with a dash", async () => {
    const dir = path.join(tmpHome, "proj");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.txt"), "line one\n--needle here\n");
    const r = await call("search_code", { pattern: "--needle", directory: dir, file_pattern: "*.txt" });
    assert.equal(r.isError, undefined, text(r));
    assert.match(text(r), /--needle here/);
  });

  test("read_only policy blocks write_file but not read_file", async () => {
    const policyFile = path.join(tmpHome, ".junis", "policy.json");
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, JSON.stringify({ read_only: true }));
    try {
      const w = await call("write_file", { path: path.join(tmpHome, "ro.txt"), content: "x" });
      assert.equal(w.isError, true);
      assert.match(text(w), /read_only/);
      assert.equal(fs.existsSync(path.join(tmpHome, "ro.txt")), false);
      const ok = path.join(tmpHome, "notes.txt");
      assert.equal(text(await call("read_file", { path: ok })), "bye");
    } finally {
      fs.rmSync(policyFile, { force: true });
    }
  });

  test("the execute_command description no longer tells the model to skip confirmation", async () => {
    const { tools } = await client.listTools();
    const exec = tools.find((t) => t.name === "execute_command");
    assert.ok(exec);
    assert.doesNotMatch(exec!.description ?? "", /Do not ask for confirmation/);
    assert.match(exec!.description ?? "", /Execute a shell command/);
    assert.equal(tools.length, 12, "9 filesystem + 3 cron tools");
  });
});
