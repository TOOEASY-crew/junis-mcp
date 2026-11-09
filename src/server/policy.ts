// src/server/policy.ts — client-side policy read from ~/.junis/policy.json.
//
// The server decides *what* an agent asks for; this file is the user's own last line of defence on the
// device, applied before any tool runs:
//   deny_read_paths        globs no tool may read (keys, cloud/CLI credentials, browser cookie DBs, this CLI's token);
//                          case-insensitive on macOS/Windows; also checked for list_directory, search_code
//                          (directory + each result line), notebook_* and browser_navigate file:// URLs
//   deny_command_patterns  extra regexes for execute_command / cron_create (built-in: catastrophic forms only)
//   builtin_command_guards set false to drop the built-in command patterns (default true)
//   read_only              true → every tool that writes files, runs commands or changes the system is refused
// A missing or invalid file means the built-in defaults; a user list replaces the built-in one
// ("deny_read_paths": [] turns the read guard off). The file is re-read on every check so edits apply at once.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

/** macOS and Windows compare paths without regard to case by default, so a pattern must too. */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

export interface Policy {
  read_only: boolean;
  deny_read_paths: string[];
  deny_command_patterns: string[];
  builtin_command_guards: boolean;
}

export interface LoadedPolicy {
  policy: Policy;
  source: "default" | "file";
  path: string;
  error?: string;
}

export const DEFAULT_DENY_READ_PATHS: readonly string[] = [
  "~/.ssh/id_*",
  "~/.ssh/*_key",
  "~/.ssh/*.pem",
  "~/.aws/credentials",
  "~/.gnupg/**",
  "~/Library/Keychains/**",
  "~/.junis/config.json",
  "~/Library/Application Support/{Google/Chrome,BraveSoftware,Microsoft Edge}/**/Cookies",
  "~/Library/Application Support/{Google/Chrome,BraveSoftware,Microsoft Edge}/**/Login Data",
  "~/.config/{google-chrome,chromium}/**/Cookies",
  "~/.config/{google-chrome,chromium}/**/Login Data",
  "~/.junis-kit/credentials.json",
  "~/.kube/config",
  "~/.azure/**",
  "~/.config/gh/hosts.yml",
  "~/.npmrc",
  "~/.docker/config.json",
  "~/.netrc",
  "~/.pgpass",
  "~/.git-credentials",
  "~/Library/Application Support/Firefox/**/cookies.sqlite",
  "~/Library/Application Support/Firefox/**/logins.json",
  "~/.mozilla/firefox/**/cookies.sqlite",
  "~/.mozilla/firefox/**/logins.json",
];

export function policyFilePath(): string {
  return path.join(os.homedir(), ".junis", "policy.json");
}

function defaults(): Policy {
  return {
    read_only: false,
    deny_read_paths: [...DEFAULT_DENY_READ_PATHS],
    deny_command_patterns: [],
    builtin_command_guards: true,
  };
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

/** Read ~/.junis/policy.json. Never throws; wrong types are ignored field by field. */
export function loadPolicy(): LoadedPolicy {
  const file = policyFilePath();
  const policy = defaults();
  let raw: string;
  try {
    if (!fs.existsSync(file)) return { policy, source: "default", path: file };
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    return { policy, source: "default", path: file, error: `cannot read ${file}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { policy, source: "default", path: file, error: `invalid JSON in ${file}: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { policy, source: "default", path: file, error: `${file} must contain a JSON object` };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.read_only === "boolean") policy.read_only = obj.read_only;
  const reads = stringList(obj.deny_read_paths);
  if (reads) policy.deny_read_paths = reads;
  const cmds = stringList(obj.deny_command_patterns);
  if (cmds) policy.deny_command_patterns = cmds;
  if (typeof obj.builtin_command_guards === "boolean") policy.builtin_command_guards = obj.builtin_command_guards;
  return { policy, source: "file", path: file };
}

// ── glob matching (own minimal matcher: *, **, ?, {a,b}; no new dependency) ───────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Expand {a,b,c} alternatives (one level is enough for the default patterns; nesting is handled recursively). */
function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const before = pattern.slice(0, m.index);
  const after = pattern.slice(m.index + m[0].length);
  const out: string[] = [];
  for (const alt of m[1].split(",")) {
    for (const rest of expandBraces(before + alt + after)) out.push(rest);
  }
  return out;
}

function globSegmentToRegExp(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**"
        i++;
        if (glob[i + 1] === "/") {
          // "**/" — zero or more directories
          i++;
          re += "(?:.*/)?";
        } else if (i === glob.length - 1 && glob[i - 2] === "/") {
          // trailing "/**" — the directory itself or anything below it
          re = re.replace(/\/$/, "");
          re += "(?:/.*)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRegExp(c);
    }
  }
  return re;
}

/** Compile a glob (after ~ expansion) to an anchored RegExp. Exported for tests. */
export function globToRegExp(pattern: string): RegExp {
  const alternatives = expandBraces(pattern).map(globSegmentToRegExp);
  return new RegExp(`^(?:${alternatives.join("|")})$`, CASE_INSENSITIVE_FS ? "i" : "");
}

function homeDirs(): string[] {
  const home = os.homedir();
  const out = [home];
  try {
    const real = fs.realpathSync(home);
    if (real !== home) out.push(real);
  } catch {
    // keep the lexical home only
  }
  return out;
}

/** "~/x" → every known spelling of the home directory (lexical and realpath'd), other patterns unchanged. */
function expandHome(pattern: string): string[] {
  if (pattern === "~" || pattern.startsWith("~/")) {
    return homeDirs().map((h) => h + pattern.slice(1));
  }
  return [pattern];
}

/** Realpath of a path that may not exist yet: resolve the deepest existing ancestor and re-append the rest. */
function bestEffortRealpath(p: string): string {
  let probe = p;
  const tail: string[] = [];
  for (;;) {
    try {
      // .native returns the on-disk spelling (macOS folds case in the JS implementation's cache)
      const real = fs.realpathSync.native(probe);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return p;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** Candidate absolute forms of a user path: lexical resolution and realpath (symlinks followed). */
function pathCandidates(p: string): string[] {
  const resolved = path.resolve(p);
  const real = bestEffortRealpath(resolved);
  return real === resolved ? [resolved] : [resolved, real];
}

/**
 * The deny_read_paths pattern a path matches, or null. Follows symlinks; relative paths resolve against cwd.
 * `asDirectory` (list_directory, search_code): the tool reads what is *inside* the path, so each candidate is
 * also tried as "a file in that directory" — "~/.ssh/*" then covers "~/.ssh" itself.
 */
export function isReadDenied(filePath: string, policy: Policy = loadPolicy().policy, asDirectory = false): string | null {
  const candidates = pathCandidates(filePath);
  if (asDirectory) for (const c of [...candidates]) candidates.push(c + path.sep + "_");
  const forMatch = candidates.map((c) => toMatchSeparators(c));
  for (const { pattern, re } of compiledDenyPatterns(policy)) {
    if (forMatch.some((c) => re.test(c))) return pattern;
  }
  return null;
}

/**
 * Globs are written with "/" (and "*" stops at "/"), so on Windows both the patterns and the candidate paths are
 * compared with "/" separators — otherwise "~/.ssh/**" never matches "C:\\Users\\me\\.ssh\\id_rsa". No-op elsewhere.
 * `sep` is a parameter so the Windows form can be tested on any platform.
 */
export function toMatchSeparators(p: string, sep: string = path.sep): string {
  return sep === "\\" ? p.replace(/\\/g, "/") : p;
}

/**
 * deny_read_paths compiled once per policy object. Compiling per call cost a home-directory realpath and a new
 * RegExp for every pattern on every path — about 1 ms per line when filtering search results (10,000 hits froze
 * the daemon for 10+ seconds).
 */
const compiledDenyCache = new WeakMap<readonly string[], { pattern: string; re: RegExp }[]>();

function compiledDenyPatterns(policy: Policy): { pattern: string; re: RegExp }[] {
  let compiled = compiledDenyCache.get(policy.deny_read_paths);
  if (!compiled) {
    compiled = [];
    for (const pattern of policy.deny_read_paths) {
      for (const expanded of expandHome(pattern)) {
        try {
          compiled.push({ pattern, re: globToRegExp(toMatchSeparators(expanded)) });
        } catch {
          // an invalid pattern is skipped; the others still apply
        }
      }
    }
    compiledDenyCache.set(policy.deny_read_paths, compiled);
  }
  return compiled;
}

/** Drop `path:line: text` lines whose file is read-denied (search_code output). Each distinct file is checked once. */
export function filterDeniedPaths(lines: string[], policy: Policy = loadPolicy().policy): string[] {
  const verdicts = new Map<string, boolean>();
  return lines.filter((line) => {
    const m = /^(.+?):\d+:/.exec(line);
    if (!m) return true;
    let denied = verdicts.get(m[1]);
    if (denied === undefined) {
      denied = isReadDenied(m[1], policy) !== null;
      verdicts.set(m[1], denied);
    }
    return !denied;
  });
}

/**
 * The local path a browser URL reads, or null when it is not a file URL. Handles the spellings a browser accepts:
 * surrounding whitespace, `view-source:file://…`, and a host part (`file://host/path` — fileURLToPath refuses a
 * non-local host on POSIX, but Chromium still opens the path).
 */
export function fileUrlToLocalPath(url: string): string | null {
  // Normalise the way the URL parser does before it looks at the scheme: tab / CR / LF are removed anywhere,
  // and leading or trailing C0 controls and spaces are stripped ("fi\tle:///…" and "\u0001file:///…" are file URLs).
  // eslint-disable-next-line no-control-regex
  const clean = (v: string): string => v.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  let u = clean(url);
  while (/^view-source:/i.test(u)) u = clean(u.slice("view-source:".length)); // the prefix can be repeated
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return null; // not an absolute URL: the browser will not open a local file from it
  }
  if (parsed.protocol !== "file:") return null;
  try {
    return fileURLToPath(parsed);
  } catch {
    // A host part (file://host/path) or a malformed escape (%z): still a file URL, so still derive a path to check.
    // Decode well-formed %XX escapes as **UTF-8 bytes** (a Latin-1 decode turns "Privé" into mojibake and a deny
    // pattern with a non-ASCII segment, or a non-ASCII home directory, would no longer match); leave the rest as written.
    const bytes: number[] = [];
    const raw = parsed.pathname;
    for (let i = 0; i < raw.length; ) {
      const hex = raw[i] === "%" ? raw.slice(i + 1, i + 3) : "";
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 3;
      } else {
        const cp = raw.codePointAt(i) as number;
        const ch = String.fromCodePoint(cp);
        for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
        i += ch.length;
      }
    }
    return Buffer.from(bytes).toString("utf8") || "/";
  }
}

// ── command guards ───────────────────────────────────────────────────────────────────────

/** Built-in catastrophic forms only — anything a user might legitimately run must stay out of this list. */
const BUILTIN_COMMAND_GUARDS: { name: string; test: (cmd: string) => boolean }[] = [
  {
    // rm with recursive+force flags on "/" or "/*" (any flag order, --long forms, --no-preserve-root, sudo, chained)
    name: "rm -rf /",
    test: (cmd) => {
      const re = /\brm\s+((?:-{1,2}[A-Za-z-]+\s+)+)\/\*?(?=\s|$|[;&|)])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(cmd)) !== null) {
        const flags = m[1].trim().split(/\s+/);
        const recursive = flags.some((f) => f === "--recursive" || (/^-[A-Za-z]+$/.test(f) && /[rR]/.test(f)));
        const force = flags.some((f) => f === "--force" || (/^-[A-Za-z]+$/.test(f) && f.includes("f")));
        if (recursive && force) return true;
      }
      return false;
    },
  },
  { name: "mkfs", test: (cmd) => /(?:^|[\s;&|])mkfs(?:\.\w+)?\s+\S/.test(cmd) },
  { name: "dd of=/dev/", test: (cmd) => /\bdd\b[^;&|]*\bof=\/dev\//.test(cmd) },
  { name: "fork bomb", test: (cmd) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(cmd) },
  {
    name: "redirect to a block device",
    test: (cmd) => />\s*\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|disk\d|mmcblk\d|rdisk\d)/.test(cmd),
  },
];

function userPatternToRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(escapeRegExp(pattern));
  }
}

/** The rule a command matches (built-in name or the user pattern), or null. */
export function isCommandDenied(command: string, policy: Policy = loadPolicy().policy): string | null {
  if (policy.builtin_command_guards) {
    for (const guard of BUILTIN_COMMAND_GUARDS) {
      if (guard.test(command)) return guard.name;
    }
  }
  for (const pattern of policy.deny_command_patterns) {
    if (userPatternToRegExp(pattern).test(command)) return pattern;
  }
  return null;
}

// ── tool-level evaluation ────────────────────────────────────────────────────────────────

/** Tools refused when read_only is true: anything that writes files, runs commands or changes the system. */
export const READ_ONLY_DENIED_TOOLS: readonly string[] = [
  "write_file",
  "edit_block",
  "execute_command",
  "cron_create",
  "cron_delete",
  "kill_process",
  "browser_upload",
  "share_file",
  "notebook_edit_cell",
  "notebook_add_cell",
  "notebook_delete_cell",
  "notebook_execute",
];

/** Tools whose argument is a file the tool reads (deny_read_paths applies). */
const FILE_READ_TOOLS: Record<string, (args: Record<string, unknown>) => string[]> = {
  read_file: (a) => (typeof a.path === "string" ? [a.path] : []),
  share_file: (a) => (typeof a.path === "string" ? [a.path] : []),
  edit_block: (a) => (typeof a.path === "string" ? [a.path] : []),
  browser_upload: (a) => (Array.isArray(a.paths) ? a.paths.filter((p): p is string => typeof p === "string") : []),
  list_directory: (a) => (typeof a.path === "string" ? [a.path] : []),
  search_code: (a) => (typeof a.directory === "string" ? [a.directory] : []),
  notebook_read: (a) => (typeof a.path === "string" ? [a.path] : []),
  notebook_edit_cell: (a) => (typeof a.path === "string" ? [a.path] : []),
  notebook_add_cell: (a) => (typeof a.path === "string" ? [a.path] : []),
  notebook_delete_cell: (a) => (typeof a.path === "string" ? [a.path] : []),
  notebook_execute: (a) => (typeof a.path === "string" ? [a.path] : []),
  browser_navigate: (a) => {
    if (typeof a.url !== "string") return [];
    const local = fileUrlToLocalPath(a.url);
    return local ? [local] : [];
  },
};

/** Tools whose path argument is a directory the tool reads into (see isReadDenied asDirectory). */
const DIRECTORY_READ_TOOLS = new Set(["list_directory", "search_code"]);

/** Tools whose argument is a shell command (deny_command_patterns applies). */
const COMMAND_TOOLS = new Set(["execute_command", "cron_create"]);

export interface PolicyDenial {
  tool: string;
  rule: "read_only" | "deny_read_paths" | "deny_command_patterns";
  matched?: string;
  subject?: string;
  message: string;
}

export function evaluatePolicy(tool: string, args: Record<string, unknown> = {}, loaded: LoadedPolicy = loadPolicy()): PolicyDenial | null {
  const { policy, path: file } = loaded;
  const where = `local policy (${file})`;
  if (policy.read_only && READ_ONLY_DENIED_TOOLS.includes(tool)) {
    return { tool, rule: "read_only", message: `Blocked by ${where}: read_only is true, so ${tool} is not allowed on this device.` };
  }
  const readPaths = FILE_READ_TOOLS[tool];
  if (readPaths) {
    for (const p of readPaths(args)) {
      const matched = isReadDenied(p, policy, DIRECTORY_READ_TOOLS.has(tool));
      if (matched) {
        return {
          tool,
          rule: "deny_read_paths",
          matched,
          subject: p,
          message: `Blocked by ${where}: ${tool} on "${p}" matches deny_read_paths pattern "${matched}". Edit policy.json to change this.`,
        };
      }
    }
  }
  if (COMMAND_TOOLS.has(tool) && typeof args.command === "string") {
    const matched = isCommandDenied(args.command, policy);
    if (matched) {
      return {
        tool,
        rule: "deny_command_patterns",
        matched,
        subject: args.command,
        message: `Blocked by ${where}: the command matches the deny rule "${matched}". Edit policy.json to change this.`,
      };
    }
  }
  return null;
}
