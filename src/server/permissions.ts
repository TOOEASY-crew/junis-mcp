// src/server/permissions.ts
//
// Tool permission levels (legacy table, kept for API compatibility) plus the client-side policy gate:
// checkPermission() now routes every call through ~/.junis/policy.json (deny_read_paths, deny_command_patterns,
// read_only — see policy.ts) and throws PolicyError when the call is refused.
import { evaluatePolicy, type PolicyDenial } from "./policy.js";
import { auditLog, summarizeArgs } from "./audit.js";

export type PermissionLevel = "auto" | "confirm" | "deny";

export const toolPermissions: Record<string, PermissionLevel> = {
  // Read-only: allowed automatically
  browser_snapshot:     "auto",
  browser_screenshot:   "auto",
  desktop_see:          "auto",
  desktop_list_apps:    "auto",
  desktop_list_windows: "auto",
  cron_list:            "auto",
  read_file:            "auto",
  share_file:           "auto",
  list_directory:       "auto",
  list_processes:       "auto",
  search_code:          "auto",
  // Interactive: confirmation recommended (currently runs like auto; UI integration planned)
  browser_click:        "confirm",
  browser_type:         "confirm",
  browser_navigate:     "confirm",
  browser_fill:         "confirm",
  browser_select:       "confirm",
  browser_press:        "confirm",
  browser_hover:        "confirm",
  browser_drag:         "confirm",
  browser_upload:       "confirm",
  browser_cookies:      "confirm",
  browser_storage:      "confirm",
  browser_dialog:       "confirm",
  desktop_click:        "confirm",
  desktop_type:         "confirm",
  desktop_hotkey:       "confirm",
  desktop_press:        "confirm",
  desktop_scroll:       "confirm",
  desktop_move:         "confirm",
  desktop_drag:         "confirm",
  desktop_menu:         "confirm",
  desktop_paste:        "confirm",
  desktop_clipboard:    "confirm",
  desktop_dialog:       "confirm",
  desktop_screenshot:   "confirm",
  desktop_open_app:     "auto",
  desktop_open_url:     "auto",
  desktop_app_quit:     "confirm",
  desktop_window:       "confirm",
  cron_create:          "confirm",
  cron_delete:          "confirm",
  edit_block:           "confirm",
  kill_process:         "confirm",
  // System changes: approval through the conversation (confirm)
  execute_command:      "confirm",
  write_file:           "confirm",
};

/** Thrown when the local policy (or a "deny" permission level) refuses a tool call. */
export class PolicyError extends Error {
  readonly denial?: PolicyDenial;
  constructor(message: string, denial?: PolicyDenial) {
    super(message);
    this.name = "PolicyError";
    this.denial = denial;
  }
}

/**
 * Permission check before running a tool.
 * - "deny" level throws PolicyError (no tool is currently at deny).
 * - Matching read_only / deny_read_paths / deny_command_patterns in ~/.junis/policy.json throws PolicyError.
 * - confirm level passes (user confirmation UI planned). Tools not in the list default to auto (pass).
 */
export function checkPermission(toolName: string, args: Record<string, unknown> = {}): void {
  const level = toolPermissions[toolName];
  if (level === "deny") {
    throw new PolicyError(
      `Tool '${toolName}' is blocked by permission policy (deny). ` +
      `To allow, update toolPermissions in src/server/permissions.ts.`
    );
  }
  const denial = evaluatePolicy(toolName, args);
  if (denial) throw new PolicyError(denial.message, denial);
}

/**
 * checkPermission + audit: a refused call is written to the audit log as "denied" before the error propagates.
 * Use this in tool handlers that are audited (execute_command, write_file, …).
 */
export function enforcePolicy(toolName: string, args: Record<string, unknown> = {}): void {
  try {
    checkPermission(toolName, args);
  } catch (err) {
    auditLog({ tool: toolName, args: summarizeArgs(toolName, args), outcome: "denied", detail: (err as Error).message });
    throw err;
  }
}
