// tests/policy.test.ts — ~/.junis/policy.json: deny_read_paths / deny_command_patterns / read_only, built-in defaults,
// user override, realpath (symlink) resolution, and checkPermission wiring.
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "junis-policy-test-"));
const originalHome = process.env.HOME;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type PolicyModule = typeof import("../src/server/policy.js");
type PermModule = typeof import("../src/server/permissions.js");
let pol: PolicyModule;
let perm: PermModule;
const policyFile = path.join(tmpHome, ".junis", "policy.json");

before(async () => {
  pol = await import("../src/server/policy.js");
  perm = await import("../src/server/permissions.js");
  fs.mkdirSync(path.join(tmpHome, ".junis"), { recursive: true });
});
after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(policyFile, { force: true });
});

function writePolicy(obj: unknown): void {
  fs.writeFileSync(policyFile, typeof obj === "string" ? obj : JSON.stringify(obj));
}

describe("loadPolicy", () => {
  test("no file → built-in defaults (read_only false, default deny lists)", () => {
    const { policy, source } = pol.loadPolicy();
    assert.equal(source, "default");
    assert.equal(policy.read_only, false);
    assert.ok(policy.deny_read_paths.length > 0);
    assert.deepEqual(policy.deny_command_patterns, []);
    assert.equal(policy.builtin_command_guards, true);
  });

  test("invalid JSON → defaults, with an error note (never throws)", () => {
    writePolicy("{ not json");
    const r = pol.loadPolicy();
    assert.equal(r.source, "default");
    assert.ok(r.error);
    assert.equal(r.policy.read_only, false);
  });

  test("a user list replaces the built-in deny_read_paths (empty list disables)", () => {
    writePolicy({ deny_read_paths: [] });
    const { policy } = pol.loadPolicy();
    assert.deepEqual(policy.deny_read_paths, []);
    writePolicy({ deny_read_paths: ["~/secret/**"] });
    assert.deepEqual(pol.loadPolicy().policy.deny_read_paths, ["~/secret/**"]);
  });

  test("wrong types are ignored field by field", () => {
    writePolicy({ read_only: "yes", deny_read_paths: "~/x", deny_command_patterns: [1, "ok"], builtin_command_guards: 0 });
    const { policy } = pol.loadPolicy();
    assert.equal(policy.read_only, false);
    assert.ok(policy.deny_read_paths.length > 1, "default list kept");
    assert.deepEqual(policy.deny_command_patterns, ["ok"]);
    assert.equal(policy.builtin_command_guards, true);
  });
});

describe("globToRegExp", () => {
  test("*, **, ?, {a,b} semantics", () => {
    const m = (pattern: string, p: string) => pol.globToRegExp(pattern).test(p);
    assert.equal(m("/h/.ssh/id_*", "/h/.ssh/id_rsa"), true);
    assert.equal(m("/h/.ssh/id_*", "/h/.ssh/id_rsa.pub"), true);
    assert.equal(m("/h/.ssh/id_*", "/h/.ssh/config"), false);
    assert.equal(m("/h/.ssh/id_*", "/h/.ssh/id_x/deep"), false, "* does not cross /");
    assert.equal(m("/h/.gnupg/**", "/h/.gnupg/private-keys-v1.d/abc.key"), true);
    assert.equal(m("/h/.gnupg/**", "/h/.gnupg"), true, "the directory itself");
    assert.equal(m("/h/.gnupg/**", "/h/.gnupg2/x"), false);
    assert.equal(m("/h/{a,b}/**/Cookies", "/h/a/Default/Cookies"), true);
    assert.equal(m("/h/{a,b}/**/Cookies", "/h/b/Cookies"), true);
    assert.equal(m("/h/{a,b}/**/Cookies", "/h/c/Cookies"), false);
    assert.equal(m("/h/x?", "/h/x1"), true);
    assert.equal(m("/h/x?", "/h/x12"), false);
    assert.equal(m("/h/a.b", "/h/aXb"), false, "dot is literal");
  });
});

describe("isReadDenied (defaults)", () => {
  test("ssh keys, aws credentials, gnupg, keychains, the junis config and browser cookie DBs are denied", () => {
    const h = tmpHome;
    const denied = [
      `${h}/.ssh/id_ed25519`, `${h}/.ssh/id_rsa`, `${h}/.ssh/github_key`,
      `${h}/.aws/credentials`, `${h}/.gnupg/pubring.kbx`, `${h}/Library/Keychains/login.keychain-db`,
      `${h}/.junis/config.json`,
      `${h}/Library/Application Support/Google/Chrome/Default/Cookies`,
      `${h}/Library/Application Support/Google/Chrome/Profile 1/Login Data`,
      `${h}/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies`,
      `${h}/Library/Application Support/Microsoft Edge/Default/Login Data`,
      `${h}/.config/google-chrome/Default/Cookies`, `${h}/.config/chromium/Default/Login Data`,
    ];
    for (const p of denied) assert.ok(pol.isReadDenied(p), `should deny ${p}`);
    const allowed = [
      `${h}/.ssh/config`, `${h}/.ssh/known_hosts`, `${h}/.aws/config`, `${h}/project/src/index.ts`,
      `${h}/Library/Application Support/Google/Chrome/Default/Bookmarks`, `${h}/.junis/policy.json`,
    ];
    for (const p of allowed) assert.equal(pol.isReadDenied(p), null, `should allow ${p}`);
  });

  test("relative paths are resolved against cwd and symlinks are followed", () => {
    const sshDir = path.join(tmpHome, ".ssh");
    fs.mkdirSync(sshDir, { recursive: true });
    const key = path.join(sshDir, "id_test");
    fs.writeFileSync(key, "KEY");
    const link = path.join(tmpHome, "innocent.txt");
    fs.symlinkSync(key, link);
    assert.ok(pol.isReadDenied(link), "symlink to a denied file");
    const linkDir = path.join(tmpHome, "dirlink");
    fs.symlinkSync(sshDir, linkDir);
    assert.ok(pol.isReadDenied(path.join(linkDir, "id_test")), "file through a symlinked directory");
    const cwd = process.cwd();
    try {
      process.chdir(tmpHome);
      assert.ok(pol.isReadDenied(".ssh/id_test"));
      assert.equal(pol.isReadDenied("innocent-real.txt"), null);
    } finally {
      process.chdir(cwd);
    }
  });

  test("user override: empty list allows everything, custom list is honoured", () => {
    writePolicy({ deny_read_paths: [] });
    assert.equal(pol.isReadDenied(`${tmpHome}/.ssh/id_rsa`), null);
    writePolicy({ deny_read_paths: ["~/vault/**"] });
    assert.ok(pol.isReadDenied(`${tmpHome}/vault/a/b.txt`));
    assert.equal(pol.isReadDenied(`${tmpHome}/.ssh/id_rsa`), null);
  });
});

describe("isCommandDenied", () => {
  test("built-in catastrophic forms only", () => {
    const denied = [
      "rm -rf /", "rm -rf / ", "rm -rf /*", "sudo rm -rf /", "rm -fr /", "rm -r -f /", "rm --recursive --force /",
      "rm -rf --no-preserve-root /", "echo hi; rm -rf /",
      "mkfs.ext4 /dev/sda1", "mkfs /dev/sdb", "dd if=/dev/zero of=/dev/sda bs=1M", "dd if=img.iso of=/dev/disk2",
      ":(){ :|:& };:", ":(){ :|: & };:", "cat x > /dev/sda", "echo 1 >/dev/nvme0n1", "> /dev/disk0",
    ];
    for (const c of denied) assert.ok(pol.isCommandDenied(c), `should deny: ${c}`);
    const allowed = [
      "ls -la /", "rm -rf /tmp/build", "rm -rf ./node_modules", "rm -rf ~/Downloads/x", "rm -rf /Users/me/proj/dist",
      "git status", "echo 'rm -rf' >> notes.txt", "npm run build", "echo done > /dev/null", "dd if=a.img of=b.img",
      "docker system prune -af", "mkfs-like tool", "cat /etc/hosts",
    ];
    for (const c of allowed) assert.equal(pol.isCommandDenied(c), null, `should allow: ${c}`);
  });

  test("user patterns are regexes; an invalid regex falls back to a literal substring", () => {
    writePolicy({ deny_command_patterns: ["\\bgit\\s+push\\s+--force", "curl ["] });
    assert.ok(pol.isCommandDenied("git push --force origin main"));
    assert.equal(pol.isCommandDenied("git push origin main"), null);
    assert.ok(pol.isCommandDenied("curl [abc]"), "literal fallback");
    assert.ok(pol.isCommandDenied("rm -rf /"), "built-ins still apply with user patterns");
  });

  test("builtin_command_guards:false disables the built-in set", () => {
    writePolicy({ builtin_command_guards: false });
    assert.equal(pol.isCommandDenied("rm -rf /"), null);
  });
});

describe("deny_read_paths hardening", () => {
  test("defaults include the kit key, kube/azure/gh/npm/docker credentials and Firefox cookies", () => {
    const d = pol.DEFAULT_DENY_READ_PATHS;
    for (const p of ["~/.junis-kit/credentials.json", "~/.kube/config", "~/.azure/**", "~/.config/gh/hosts.yml", "~/.npmrc", "~/.docker/config.json", "~/.netrc", "~/.pgpass", "~/.git-credentials", "~/.ssh/*.pem"]) {
      assert.ok(d.includes(p), p);
    }
  });
  test("case-insensitive match on case-insensitive filesystems", () => {
    const home = os.homedir();
    const policy = { ...pol.loadPolicy().policy, deny_read_paths: ["~/.ssh/id_*"] };
    assert.equal(pol.isReadDenied(path.join(home, ".ssh", "id_ed25519"), policy), "~/.ssh/id_*");
    const upper = pol.isReadDenied(path.join(home, ".SSH", "ID_ed25519"), policy);
    if (process.platform === "darwin" || process.platform === "win32") assert.equal(upper, "~/.ssh/id_*");
    else assert.equal(upper, null);
  });
  test("list_directory / search_code / notebook_* / browser_navigate file:// are policy-checked", () => {
    const home = os.homedir();
    writePolicy({ deny_read_paths: ["~/.ssh/**"] });
    assert.ok(pol.evaluatePolicy("list_directory", { path: path.join(home, ".ssh") }));
    assert.ok(pol.evaluatePolicy("search_code", { directory: path.join(home, ".ssh") }));
    assert.ok(pol.evaluatePolicy("notebook_read", { path: path.join(home, ".ssh", "x.ipynb") }));
    for (const tool of ["notebook_edit_cell", "notebook_add_cell", "notebook_delete_cell", "notebook_execute"]) {
      assert.ok(pol.evaluatePolicy(tool, { path: path.join(home, ".ssh", "x.ipynb") }), tool);
      assert.equal(pol.evaluatePolicy(tool, { path: path.join(home, "work", "x.ipynb") }), null, tool);
    }
    assert.ok(pol.evaluatePolicy("browser_navigate", { url: "file://" + path.join(home, ".ssh", "id_rsa") }));
    assert.equal(pol.evaluatePolicy("browser_navigate", { url: "https://example.com" }), null);
    assert.equal(pol.evaluatePolicy("list_directory", { path: home }), null);
  });
  test("filterDeniedPaths drops denied files from search output", () => {
    const home = os.homedir();
    writePolicy({ deny_read_paths: ["~/.ssh/**"] });
    const lines = [`${path.join(home, ".ssh", "id_rsa")}:1: secret`, `${path.join(home, "proj", "a.ts")}:3: ok`];
    assert.deepEqual(pol.filterDeniedPaths(lines), [lines[1]]);
  });

  test("filterDeniedPaths stays fast on large results (patterns compiled once, each file checked once)", () => {
    const home = os.homedir();
    writePolicy({ deny_read_paths: ["~/.ssh/**"] });
    const policy = pol.loadPolicy().policy;
    const many: string[] = [];
    for (let i = 0; i < 20000; i++) many.push(`${path.join(home, "proj", "src", `f${i % 200}.ts`)}:${i}: const x = ${i}`);
    many.push(`${path.join(home, ".ssh", "id_rsa")}:1: secret`);
    const t0 = Date.now();
    const kept = pol.filterDeniedPaths(many, policy);
    const ms = Date.now() - t0;
    assert.equal(kept.length, 20000);
    // before: about 1.2 ms per line (24 s for this input). Generous bound so a slow CI machine does not flake.
    assert.ok(ms < 3000, `filterDeniedPaths took ${ms} ms for 20,001 lines`);
  });

  test("browser file URLs in every spelling the browser accepts are checked", () => {
    const home = os.homedir();
    writePolicy({ deny_read_paths: ["~/.ssh/**"] });
    const key = path.join(home, ".ssh", "id_rsa");
    for (const url of [`file://${key}`, `  file://${key}`, `view-source:file://${key}`, `VIEW-SOURCE:FILE://${key}`, `file://otherhost${key}`,
                       // the original bypasses: a loopback host part, an escaped dot, a single-slash file URL
                       `file://127.0.0.1${key}`, `file://${key.replace("/.ssh/", "/%2Essh/")}`, `file:${key}`]) {
      assert.ok(pol.evaluatePolicy("browser_navigate", { url }), url);
    }
    // the URL parser drops tab/CR/LF anywhere and leading control characters before reading the scheme
    for (const url of [`fi\tle://${key}`, `\u0001file://${key}`, `file:\n//${key}`, `view-source:\tfile://${key}`]) {
      assert.ok(pol.evaluatePolicy("browser_navigate", { url }), JSON.stringify(url));
    }
    // a malformed escape elsewhere in the path must not make the URL unchecked
    assert.equal(pol.fileUrlToLocalPath(`file://${path.join(home, ".ssh")}/100%z/id_rsa`), `${path.join(home, ".ssh")}/100%z/id_rsa`);
    assert.ok(pol.evaluatePolicy("browser_navigate", { url: `file://${path.join(home, ".ssh")}/100%z/id_rsa` }));
    assert.equal(pol.fileUrlToLocalPath("not a url"), null);
    assert.ok(pol.evaluatePolicy("browser_navigate", { url: `view-source:view-source:file://${key}` }));
    // non-ASCII path segments survive the fallback decode (host part / malformed escape) as UTF-8
    assert.equal(pol.fileUrlToLocalPath("file://otherhost/Users/me/Privé/key.pem"), "/Users/me/Privé/key.pem");
    assert.equal(pol.fileUrlToLocalPath("file://otherhost/Users/me/Priv%C3%A9/key.pem"), "/Users/me/Privé/key.pem");
    assert.equal(pol.fileUrlToLocalPath("file:///Users/me/Privé/100%z/key.pem"), "/Users/me/Privé/100%z/key.pem");
    writePolicy({ deny_read_paths: ["~/Privé/**"] });
    const hidden = path.join(home, "Privé", "key.pem");
    for (const url of [`file://${hidden}`, `file://otherhost${hidden}`, `file://${path.join(home, "Privé")}/100%z/key.pem`]) {
      assert.ok(pol.evaluatePolicy("browser_navigate", { url }), url);
    }
    writePolicy({ deny_read_paths: ["~/.ssh/**"] });
    assert.equal(pol.fileUrlToLocalPath("https://example.com/file:///x"), null);
    assert.equal(pol.fileUrlToLocalPath("  about:blank"), null);
    assert.equal(pol.evaluatePolicy("browser_navigate", { url: `file://${path.join(home, "proj", "index.html")}` }), null);
  });

  test("Windows separators: patterns and paths are compared with forward slashes", () => {
    assert.equal(pol.toMatchSeparators("C:\\Users\\me\\.ssh\\id_rsa", "\\"), "C:/Users/me/.ssh/id_rsa");
    assert.equal(pol.toMatchSeparators("/home/me/a\\b", "/"), "/home/me/a\\b"); // a backslash is an ordinary character on POSIX
    const re = pol.globToRegExp(pol.toMatchSeparators("C:\\Users\\me/.ssh/**", "\\"));
    assert.ok(re.test(pol.toMatchSeparators("C:\\Users\\me\\.ssh\\id_rsa", "\\")));
    assert.ok(!re.test(pol.toMatchSeparators("C:\\Users\\me\\proj\\a.ts", "\\")));
  });
});

describe("evaluatePolicy / checkPermission", () => {
  test("default policy: writes and commands allowed, protected reads denied", () => {
    assert.equal(perm.checkPermission("execute_command", { command: "ls" }), undefined);
    assert.equal(perm.checkPermission("write_file", { path: `${tmpHome}/notes.txt` }), undefined);
    assert.throws(() => perm.checkPermission("read_file", { path: `${tmpHome}/.ssh/id_rsa` }), perm.PolicyError);
    assert.throws(() => perm.checkPermission("share_file", { path: `${tmpHome}/.aws/credentials` }), /policy/i);
    assert.throws(() => perm.checkPermission("edit_block", { path: `${tmpHome}/.junis/config.json` }), perm.PolicyError);
    assert.throws(() => perm.checkPermission("browser_upload", { paths: ["/tmp/ok.png", `${tmpHome}/.ssh/id_rsa`] }), perm.PolicyError);
    assert.throws(() => perm.checkPermission("execute_command", { command: "rm -rf /" }), perm.PolicyError);
    assert.throws(() => perm.checkPermission("cron_create", { command: "mkfs.ext4 /dev/sda" }), perm.PolicyError);
    // the message tells the user where the policy lives
    assert.throws(() => perm.checkPermission("read_file", { path: `${tmpHome}/.ssh/id_rsa` }), /policy\.json/);
  });

  test("read_only: true denies the mutating tools and keeps reads", () => {
    writePolicy({ read_only: true });
    for (const tool of ["write_file", "edit_block", "execute_command", "cron_create", "cron_delete", "kill_process", "browser_upload", "share_file", "notebook_edit_cell", "notebook_add_cell", "notebook_delete_cell", "notebook_execute"]) {
      assert.throws(() => perm.checkPermission(tool, { path: `${tmpHome}/x`, command: "ls", pid: 1 }), /read_only/, tool);
    }
    for (const tool of ["read_file", "list_directory", "search_code", "list_processes", "cron_list", "browser_snapshot", "notebook_read"]) {
      assert.equal(perm.checkPermission(tool, { path: `${tmpHome}/x` }), undefined, tool);
    }
  });

  test("legacy exports still exist (toolPermissions table, PermissionLevel values)", () => {
    assert.equal(typeof perm.toolPermissions, "object");
    assert.equal(perm.toolPermissions.execute_command, "confirm");
  });
});
