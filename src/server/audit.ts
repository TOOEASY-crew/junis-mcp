// src/server/audit.ts — local audit log of mutating tool calls: ~/.junis/logs/audit.jsonl (0600).
//
// One JSON line per call: { ts, tool, args, outcome, detail? }. `args` is a short summary (path, command,
// pid — never file contents or command output), cut at 200 characters. The file rotates to audit.jsonl.1
// at 5 MB. JUNIS_AUDIT_LOG=0 turns it off. Logging never throws — a broken log must not break a tool.
import fs from "fs";
import os from "os";
import path from "path";

export type AuditOutcome = "ok" | "error" | "denied";

export interface AuditEntry {
  tool: string;
  args: string;
  outcome: AuditOutcome;
  detail?: string;
}

export const AUDIT_MAX_ARGS = 200;
export const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

export function auditLogPath(): string {
  return path.join(os.homedir(), ".junis", "logs", "audit.jsonl");
}

export function auditEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.JUNIS_AUDIT_LOG ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** One line, at most AUDIT_MAX_ARGS characters, control characters replaced by spaces. */
function clip(text: string, max = AUDIT_MAX_ARGS): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

/** Short, content-free description of a tool call's arguments. */
export function summarizeArgs(tool: string, args: Record<string, unknown> = {}): string {
  let summary: string;
  switch (tool) {
    case "write_file":
    case "edit_block":
    case "share_file":
    case "read_file":
    case "notebook_execute":
    case "notebook_read":
    case "list_directory":
      summary = str(args.path);
      break;
    case "search_code":
      // the pattern is the agent's query, not file content, but the directory is what the policy judges
      summary = `directory=${str(args.directory)}`;
      break;
    case "browser_navigate":
      summary = str(args.url);
      break;
    case "execute_command":
      summary = str(args.command) + (args.background ? " (background)" : "");
      break;
    case "kill_process":
      summary = `pid=${str(args.pid)}` + (args.signal ? ` signal=${str(args.signal)}` : "");
      break;
    case "cron_create":
      summary = `${str(args.schedule)} ${str(args.command)}` + (args.label ? ` (${str(args.label)})` : "");
      break;
    case "cron_delete":
      summary = args.id !== undefined && args.id !== null ? `id=${str(args.id)}` : `command=${str(args.command)}`;
      break;
    case "browser_upload":
      summary = `ref=${str(args.ref)} ${Array.isArray(args.paths) ? args.paths.map(str).join(", ") : ""}`;
      break;
    case "notebook_edit_cell":
    case "notebook_delete_cell":
      summary = `${str(args.path)} cell=${str(args.cell_index)}`;
      break;
    case "notebook_add_cell":
      summary = `${str(args.path)}` + (args.position !== undefined ? ` position=${str(args.position)}` : "");
      break;
    default: {
      // Unknown tool: keys only, so no content can leak through a new tool by accident.
      summary = Object.keys(args).join(",");
    }
  }
  return clip(summary.trim());
}

function rotateIfNeeded(file: string): void {
  try {
    const st = fs.statSync(file);
    if (st.size > AUDIT_ROTATE_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // no file yet
  }
}

/** Append one entry. Never throws. */
export function auditLog(entry: AuditEntry): void {
  try {
    if (!auditEnabled()) return;
    const file = auditLogPath();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    rotateIfNeeded(file);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tool: entry.tool,
      args: clip(entry.args),
      outcome: entry.outcome,
      ...(entry.detail ? { detail: clip(entry.detail) } : {}),
    });
    fs.appendFileSync(file, line + "\n", { encoding: "utf-8", mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows has no POSIX modes
    }
  } catch {
    // never let logging break a tool
  }
}
