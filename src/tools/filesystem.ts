// src/tools/filesystem.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { exec, execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { glob } from "glob";
import { z } from "zod";
import { enforcePolicy } from '../server/permissions.js';
import { auditLog, summarizeArgs } from "../server/audit.js";
import { RelayClient } from "../relay/client.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const DEFAULT_MAX_FILE_MB = 50;

/** Size cap for read_file / share_file: JUNIS_MAX_FILE_MB (positive number) or 50 MB. */
export function maxFileBytes(env: Record<string, string | undefined> = process.env): number {
  const mb = Number(env.JUNIS_MAX_FILE_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_FILE_MB) * 1024 * 1024;
}

/** ripgrep arguments with user input after "--" so a pattern or path starting with "-" is never read as an option. */
export function buildRgArgs(pattern: string, directory: string, filePattern: string): string[] {
  const args = ["--no-heading", "-n", "--max-count", "200"];
  if (filePattern && filePattern !== "**/*") args.push("-g", filePattern);
  args.push("--", pattern, directory);
  return args;
}

/** Case-insensitive RegExp for the glob fallback; an invalid pattern falls back to a literal match instead of throwing. */
export function safeRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

/** Reject files above the cap before reading them into memory (and into the chat). */
async function assertFileSize(filePath: string): Promise<void> {
  const st = await fs.stat(filePath);
  const limit = maxFileBytes();
  if (st.size > limit) {
    throw new Error(`File too large: ${(st.size / 1024 / 1024).toFixed(1)} MB exceeds the ${limit / 1024 / 1024} MB limit (set JUNIS_MAX_FILE_MB to raise it)`);
  }
}

/** Write the new crontab through a private temp directory (unpredictable name, owner-only). */
async function installCrontab(content: string): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "junis-"));
  const tmpFile = path.join(dir, "crontab.txt");
  try {
    await fs.writeFile(tmpFile, content, { encoding: "utf-8", mode: 0o600 });
    await execFileAsync("crontab", [tmpFile]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export class FilesystemTools {
  private relayClient?: RelayClient;

  register(server: McpServer, relayClient?: RelayClient): void {
    this.relayClient = relayClient;
    // execute_command
    server.tool(
      "execute_command",
      [
        "Execute a shell command on the user's local device.",
        "",
        "ROUTING:",
        "- Use for system commands, package managers (npm, pip, brew), git, build tools, and scripting.",
        "- For reading files prefer read_file, for editing prefer edit_block, for searching prefer search_code.",
        "- NOT for macOS app GUI interaction. Use desktop_* tools instead: desktop_open_app, desktop_see, desktop_click, desktop_type, desktop_paste, desktop_hotkey, desktop_scroll, desktop_move, desktop_menu, desktop_screenshot.",
        "- Exception: permission fix commands (swift -e, peekaboo permissions, open 'x-apple.systempreferences:...').",
        "- Exception: osascript coordinate queries — Use osascript via this tool to query exact UI element position and size before any click/move/drag operation.",
        "  Pattern: osascript + System Events → position + size → center = (x + w/2, y + h/2) → desktop_click(coords).",
        "  This is the ONLY reliable way to get pixel-accurate coordinates on macOS. NEVER estimate coords from screenshots.",
        "",
        "BEHAVIOR:",
        "- Execute commands directly when the user requests them.",
        "- If a command fails, analyze the error and suggest an alternative. Do not retry the identical command more than twice.",
        "",
        "BACKGROUND PROCESSES:",
        "- If background=true, use list_processes to check status and kill_process to stop it later.",
        "",
        "SAFETY:",
        "- Commands run with the user's full permissions. Use absolute paths when possible. Quote paths containing spaces.",
      ].join("\n"),
      {
        command: z.string().describe("The shell command to execute. Use absolute paths when possible. Quote paths containing spaces."),
        timeout_ms: z.number().optional().default(120000).describe("Maximum execution time in milliseconds (default: 120000). Increase for very long-running builds or downloads."),
        background: z.boolean().optional().default(false).describe("Run in background without waiting for completion. Use for servers or long-running processes."),
      },
      async ({ command, timeout_ms, background }) => {
        const auditArgs = summarizeArgs("execute_command", { command, background });
        enforcePolicy("execute_command", { command, background });
        if (background) {
          // Detached so it outlives this request; the PID lets list_processes / kill_process manage it.
          const bg = spawn("sh", ["-c", command], { detached: true, stdio: "ignore" });
          bg.unref();
          auditLog({ tool: "execute_command", args: auditArgs, outcome: "ok", detail: `pid=${bg.pid ?? "?"}` });
          return { content: [{ type: "text", text: `Background execution started (PID: ${bg.pid ?? "unknown"})` }] };
        }
        const requestId = this.relayClient?.currentRequestId ?? null;
        // Send the command line first (shown in the CodeOutputBlock)
        if (requestId) {
          this.relayClient?.sendProgress(requestId, `$ ${command}`);
        }
        return new Promise((resolve) => {
          const child = spawn("sh", ["-c", command], {
            timeout: timeout_ms,
          });

          let stdoutBuf = "";
          let stderrBuf = "";
          let stdoutLineBuffer = "";
          let stderrLineBuffer = "";

          const flushLines = (buffer: string, newChunk: string): string => {
            const combined = buffer + newChunk;
            const lines = combined.split("\n");
            // Last element may be incomplete — keep it in buffer
            const incomplete = lines.pop() ?? "";
            for (const line of lines) {
              if (requestId) {
                this.relayClient?.sendProgress(requestId, line);
              }
            }
            return incomplete;
          };

          child.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stdoutBuf += text;
            stdoutLineBuffer = flushLines(stdoutLineBuffer, text);
          });

          child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stderrBuf += text;
            stderrLineBuffer = flushLines(stderrLineBuffer, text);
          });

          child.on("close", (code, signal) => {
            // Flush remaining line buffers
            if (stdoutLineBuffer && requestId) {
              this.relayClient?.sendProgress(requestId, stdoutLineBuffer);
            }
            if (stderrLineBuffer && requestId) {
              this.relayClient?.sendProgress(requestId, stderrLineBuffer);
            }

            if (signal) {
              auditLog({ tool: "execute_command", args: auditArgs, outcome: "error", detail: `signal ${signal}` });
              resolve({
                content: [
                  {
                    type: "text" as const,
                    text: `Killed by signal ${signal} (timeout: ${timeout_ms}ms)`,
                  },
                ],
                isError: true,
              });
            } else if (code !== 0 && code !== null) {
              auditLog({ tool: "execute_command", args: auditArgs, outcome: "error", detail: `exit ${code}` });
              resolve({
                content: [
                  {
                    type: "text" as const,
                    text: `Error (exit ${code}): ${stderrBuf || stdoutBuf || "(no output)"}`,
                  },
                ],
                isError: true,
              });
            } else {
              auditLog({ tool: "execute_command", args: auditArgs, outcome: "ok" });
              resolve({
                content: [{ type: "text" as const, text: stdoutBuf || stderrBuf || "(no output)" }],
              });
            }
          });

          child.on("error", (err: NodeJS.ErrnoException) => {
            auditLog({ tool: "execute_command", args: auditArgs, outcome: "error", detail: err.message });
            resolve({
              content: [
                {
                  type: "text" as const,
                  text: `Error: ${err.message}`,
                },
              ],
              isError: true,
            });
          });
        });
      }
    );

    // read_file
    server.tool(
      "read_file",
      [
        "Read the contents of a file from the local filesystem.",
        "",
        "Returns file content as text (utf-8) or base64 for binary files. Supports any file type.",
        "For searching within files, prefer search_code instead. For listing directory contents, use list_directory.",
      ].join("\n"),
      {
        path: z.string().describe("Absolute or relative file path to read"),
        encoding: z
          .enum(["utf-8", "base64"])
          .optional()
          .default("utf-8")
          .describe("'utf-8' for text files (default), 'base64' for binary files (images, PDFs, archives)"),
      },
      async ({ path: filePath, encoding }) => {
        enforcePolicy("read_file", { path: filePath });
        try {
          await assertFileSize(filePath);
          const content = await fs.readFile(filePath, encoding as BufferEncoding);
          return { content: [{ type: "text", text: content }] };
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === "ENOENT") {
            return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }], isError: true };
          }
          return { content: [{ type: "text", text: `❌ Failed to read file: ${e.message}` }], isError: true };
        }
      }
    );

    // write_file
    server.tool(
      "write_file",
      [
        "Create a new file or completely overwrite an existing file. Parent directories are created automatically.",
        "",
        "WARNING: This replaces the entire file content. For partial modifications, use edit_block instead.",
        "Prefer edit_block over write_file for existing files — it's safer and preserves unmodified content.",
      ].join("\n"),
      {
        path: z.string().describe("File path to create or overwrite. Parent directories are auto-created."),
        content: z.string().describe("Complete file content. This replaces the entire file."),
      },
      async ({ path: filePath, content }) => {
        enforcePolicy("write_file", { path: filePath });
        try {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, "utf-8");
        } catch (err) {
          auditLog({ tool: "write_file", args: summarizeArgs("write_file", { path: filePath }), outcome: "error", detail: (err as Error).message });
          throw err;
        }
        auditLog({ tool: "write_file", args: summarizeArgs("write_file", { path: filePath }), outcome: "ok" });
        return { content: [{ type: "text", text: "File saved" }] };
      }
    );

    // list_directory
    server.tool(
      "list_directory",
      [
        "List files and subdirectories in the specified path. Returns entries with type indicators (📁 directory, 📄 file).",
        "Use this to explore project structure before reading or modifying files.",
      ].join("\n"),
      {
        path: z.string().describe("Directory path to list"),
      },
      async ({ path: dirPath }) => {
        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          const lines = entries.map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === "ENOENT") {
            return { content: [{ type: "text", text: `❌ Directory not found: ${dirPath}` }], isError: true };
          }
          return { content: [{ type: "text", text: `❌ Failed to read directory: ${e.message}` }], isError: true };
        }
      }
    );

    // search_code
    server.tool(
      "search_code",
      [
        "Search for text patterns across files using regex. Uses ripgrep for speed with glob fallback.",
        "",
        "Use this to find code definitions, function references, configuration values, or any text pattern.",
        "Returns matching lines with file paths and line numbers for precise navigation.",
      ].join("\n"),
      {
        pattern: z.string().describe("Search pattern with full regex support (e.g. 'function\\s+\\w+', 'import.*from', 'TODO')"),
        directory: z.string().optional().default(".").describe("Root directory to search from (default: current working directory)"),
        file_pattern: z.string().optional().default("**/*").describe("Glob pattern to filter files (e.g. '**/*.ts', '*.py', 'src/**/*.js')"),
      },
      async ({ pattern, directory, file_pattern }) => {
        // execFileAsync takes an argument array, so there is no shell injection
        try {
          const { stdout } = await execFileAsync(
            "rg",
            buildRgArgs(pattern, directory, file_pattern),
            { timeout: 10000 }
          );
          return { content: [{ type: "text", text: stdout || "No results" }] };
        } catch {
          const safeDirectory = path.resolve(directory);
          const files = await glob(file_pattern, { cwd: safeDirectory });
          const results: string[] = [];
          for (const file of files.slice(0, 100)) {
            try {
              const content = await fs.readFile(
                path.join(safeDirectory, file),
                "utf-8"
              );
              const lines = content.split("\n");
              const re = safeRegExp(pattern);
              lines.forEach((line, i) => {
                if (re.test(line)) results.push(`${file}:${i + 1}: ${line}`);
              });
            } catch {
              // Ignore file read failures
            }
          }
          return {
            content: [
              { type: "text", text: results.join("\n") || "No results" },
            ],
          };
        }
      }
    );

    // list_processes
    server.tool(
      "list_processes",
      "List the top 30 running processes sorted by CPU usage. Use this to identify resource-heavy processes, find PIDs for kill_process, or diagnose performance issues.",
      {},
      async () => {
        const cmd =
          process.platform === "win32"
            ? "tasklist"
            : process.platform === "darwin"
            ? "ps aux | sort -rk 3 | head -30"
            : "ps aux --sort=-%cpu | head -30";
        const { stdout } = await execAsync(cmd);
        return { content: [{ type: "text", text: stdout }] };
      }
    );

    // kill_process
    server.tool(
      "kill_process",
      [
        "Terminate a process by PID. Default: sends SIGTERM (graceful shutdown), waits 3 seconds, then auto-applies SIGKILL if still alive.",
        "",
        "SAFETY: Only kill processes the user explicitly identifies. Never kill system-critical processes (init, systemd, loginwindow, WindowServer) without explicit instruction.",
      ].join("\n"),
      {
        pid: z.number().int().positive().describe("PID of the process to terminate (use list_processes to find PIDs)"),
        signal: z
          .enum(["SIGTERM", "SIGKILL"])
          .optional()
          .default("SIGTERM")
          .describe("SIGTERM (default): graceful shutdown with 3s auto-SIGKILL fallback. SIGKILL: immediate force kill."),
      },
      async ({ pid, signal }) => {
        enforcePolicy("kill_process", { pid, signal });
        const audit = (outcome: "ok" | "error", detail?: string) =>
          auditLog({ tool: "kill_process", args: summarizeArgs("kill_process", { pid, signal }), outcome, detail });
        // taskkill and kill -9 throw on failure; log that before the error reaches the agent.
        const run = async (cmd: string) => {
          try {
            return await execAsync(cmd);
          } catch (err) {
            audit("error", (err as Error).message);
            throw err;
          }
        };
        const isWindows = process.platform === "win32";

        // Windows only supports taskkill /F, so handle it separately
        if (isWindows) {
          await run(`taskkill /PID ${pid} /F`);
          audit("ok");
          return {
            content: [{ type: "text", text: `PID ${pid} killed (taskkill /F)` }],
          };
        }

        // Kill immediately when SIGKILL was explicitly requested
        if (signal === "SIGKILL") {
          await run(`kill -9 ${pid}`);
          audit("ok", "SIGKILL");
          return {
            content: [{ type: "text", text: `PID ${pid} force killed (SIGKILL)` }],
          };
        }

        // Step 1: try SIGTERM
        try {
          await execAsync(`kill -15 ${pid}`);
        } catch {
          audit("error", "process does not exist or permission denied");
          return {
            content: [
              { type: "text", text: `PID ${pid} kill failed: process does not exist or permission denied.` },
            ],
            isError: true,
          };
        }

        // Step 2: wait 3 seconds, then check whether the process is still alive
        await new Promise<void>((resolve) => setTimeout(resolve, 3000));

        const isAlive = await execAsync(`kill -0 ${pid}`)
          .then(() => true)
          .catch(() => false);

        if (!isAlive) {
          audit("ok", "SIGTERM");
          return {
            content: [{ type: "text", text: `PID ${pid} killed (SIGTERM)` }],
          };
        }

        // Step 3: still alive, so escalate to SIGKILL
        await run(`kill -9 ${pid}`);
        audit("ok", "SIGTERM then SIGKILL");
        return {
          content: [
            {
              type: "text",
              text: `PID ${pid} force killed (SIGTERM unresponsive, auto SIGKILL applied)`,
            },
          ],
        };
      }
    );

    // edit_block
    server.tool(
      "edit_block",
      [
        "Replace a specific text block in a file with new text (diff-based partial edit).",
        "",
        "WORKFLOW: Always use read_file first to see current content, then use edit_block with the exact text to replace.",
        "The old_string must match character-for-character including whitespace, indentation, and line breaks.",
        "If multiple matches exist, include more surrounding context to make it unique, or set replace_all=true.",
        "",
        "Prefer this over write_file for modifying existing files — it only changes what you specify and preserves the rest.",
      ].join("\n"),
      {
        path: z.string().describe("Path to the file to edit. The file must already exist."),
        old_string: z.string().describe("The exact text to find and replace. Must match character-for-character including whitespace and newlines. Include enough context for uniqueness."),
        new_string: z.string().describe("The replacement text. Use empty string to delete the matched text."),
        replace_all: z.boolean().optional().default(false).describe("If true, replace ALL matches. If false (default), require exactly one match (errors on ambiguous multiple matches)."),
      },
      async ({ path: filePath, old_string, new_string, replace_all }) => {
        enforcePolicy("edit_block", { path: filePath });
        const auditArgs = summarizeArgs("edit_block", { path: filePath });
        let replaced: number;
        try {
          const content = await fs.readFile(filePath, "utf-8");

          // Check that old_string exists
          if (!content.includes(old_string)) {
            throw new Error(`old_string not found in file: ${filePath}`);
          }

          // Count matches
          let count = 0;
          let pos = 0;
          while ((pos = content.indexOf(old_string, pos)) !== -1) {
            count++;
            pos += old_string.length;
          }

          if (!replace_all && count > 1) {
            throw new Error(
              `Found ${count} matches. Set replace_all to true or include more context to narrow it down.`
            );
          }

          let result: string;
          if (replace_all) {
            result = content.split(old_string).join(new_string);
            replaced = count;
          } else {
            result = content.replace(old_string, new_string);
            replaced = 1;
          }

          await fs.writeFile(filePath, result, "utf-8");
        } catch (err) {
          // A failed edit is logged too: the path and the error, never the file text.
          auditLog({ tool: "edit_block", args: auditArgs, outcome: "error", detail: (err as Error).message });
          throw err;
        }
        auditLog({ tool: "edit_block", args: auditArgs, outcome: "ok", detail: `${replaced} replaced` });
        return {
          content: [{ type: "text", text: `Replaced (${replaced} occurrence(s) changed)` }],
        };
      }
    );

    // ── cron_create ──────────────────────────────────────────────
    server.tool(
      "cron_create",
      [
        "Create a recurring scheduled task (cron job) using standard cron syntax.",
        "",
        "Common schedules: '*/5 * * * *' (every 5 min), '0 9 * * 1-5' (weekdays 9am), '0 0 * * *' (daily midnight), '0 */2 * * *' (every 2 hours).",
        "Duplicate commands are automatically detected and rejected. Use cron_list to see existing jobs.",
      ].join("\n"),
      {
        schedule: z.string().describe("Cron schedule expression (5 fields: minute hour day month weekday). Examples: '*/5 * * * *' (every 5 min), '0 9 * * 1-5' (weekdays 9am)"),
        command: z.string().describe("Shell command to execute on schedule"),
        label: z.string().optional().describe("Human-readable label for identification (e.g. 'daily-backup', 'log-cleanup')"),
      },
      async ({ schedule, command, label }) => {
        enforcePolicy("cron_create", { schedule, command, label });
        const auditArgs = summarizeArgs("cron_create", { schedule, command, label });
        try {
          // Read the current crontab
          let existing = "";
          try {
            const { stdout } = await execAsync("crontab -l");
            existing = stdout;
          } catch {
            // No crontab yet: start from an empty string
          }

          // Duplicate check (same command already present)
          if (existing.includes(command)) {
            auditLog({ tool: "cron_create", args: auditArgs, outcome: "error", detail: "duplicate command" });
            return {
              content: [{ type: "text", text: `⚠️  A cron job with this command already exists.` }],
              isError: true,
            };
          }

          // Append the new entry
          const comment = label ? `# junis:${label}\n` : "# junis-cron\n";
          const newEntry = `${comment}${schedule} ${command}\n`;
          const updated = existing.trimEnd() + "\n" + newEntry;

          // Update the crontab (via a temp file)
          await installCrontab(updated);
          auditLog({ tool: "cron_create", args: auditArgs, outcome: "ok" });

          return {
            content: [{ type: "text", text: `✅ Cron job created:\n  schedule: ${schedule}\n  command: ${command}${label ? `\n  label: ${label}` : ""}` }],
          };
        } catch (err) {
          auditLog({ tool: "cron_create", args: auditArgs, outcome: "error", detail: (err as Error).message });
          return {
            content: [{ type: "text", text: `❌ Failed to create cron job: ${(err as Error).message}` }],
            isError: true,
          };
        }
      }
    );

    // ── cron_list ────────────────────────────────────────────────
    server.tool(
      "cron_list",
      "List all scheduled cron jobs with their IDs, labels, schedules, and commands. Use the returned ID numbers with cron_delete to remove specific jobs.",
      {},
      async () => {
        try {
          const { stdout } = await execAsync("crontab -l");
          const lines = stdout.trim().split("\n").filter(l => l.trim());
          if (lines.length === 0) {
            return { content: [{ type: "text", text: "No cron jobs found." }] };
          }

          // Parse entries: pair each comment (label) with its cron line
          const entries: Array<{ id: number; label?: string; schedule: string; command: string }> = [];
          let pendingLabel: string | undefined;
          let id = 1;

          for (const line of lines) {
            if (line.startsWith("#")) {
              const match = line.match(/^# junis:(.+)$/);
              pendingLabel = match ? match[1].trim() : undefined;
              continue;
            }
            // Parse the cron line (5 time fields + command)
            const parts = line.split(/\s+/);
            if (parts.length >= 6) {
              const schedule = parts.slice(0, 5).join(" ");
              const command = parts.slice(5).join(" ");
              entries.push({ id: id++, label: pendingLabel, schedule, command });
            }
            pendingLabel = undefined;
          }

          if (entries.length === 0) {
            return { content: [{ type: "text", text: stdout }] };
          }

          const output = entries.map(e =>
            `[${e.id}] ${e.label ? `(${e.label}) ` : ""}${e.schedule}  →  ${e.command}`
          ).join("\n");

          return { content: [{ type: "text", text: output }] };
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException & { code?: number };
          if (e.code === 1) {
            return { content: [{ type: "text", text: "No cron jobs found (crontab is empty)." }] };
          }
          return {
            content: [{ type: "text", text: `❌ Failed to list cron jobs: ${e.message}` }],
            isError: true,
          };
        }
      }
    );

    // ── cron_delete ──────────────────────────────────────────────
    server.tool(
      "cron_delete",
      "Delete a scheduled cron job by its ID (from cron_list output) or by matching command string. Associated comment labels are automatically cleaned up.",
      {
        id: z.number().optional().describe("Cron job ID from cron_list output (e.g. 1, 2, 3)"),
        command: z.string().optional().describe("Delete all jobs matching this command string"),
      },
      async ({ id, command }) => {
        enforcePolicy("cron_delete", { id, command });
        const auditArgs = summarizeArgs("cron_delete", { id, command });
        if (!id && !command) {
          auditLog({ tool: "cron_delete", args: auditArgs, outcome: "error", detail: "no id or command" });
          return {
            content: [{ type: "text", text: "❌ Provide either id or command to identify the cron job." }],
            isError: true,
          };
        }

        try {
          let existing = "";
          try {
            const { stdout } = await execAsync("crontab -l");
            existing = stdout;
          } catch {
            auditLog({ tool: "cron_delete", args: auditArgs, outcome: "error", detail: "no crontab" });
            return { content: [{ type: "text", text: "No cron jobs to delete." }] };
          }

          const lines = existing.split("\n");

          if (command) {
            // Delete by command match
            const filtered: string[] = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(command)) {
                // Also remove the line just above if it is a junis comment
                if (filtered.length > 0 && filtered[filtered.length - 1].trim().startsWith('#')) {
                  filtered.pop();
                }
                // Skip the command line itself as well
                continue;
              }
              filtered.push(lines[i]);
            }
            if (filtered.length === lines.length) {
              auditLog({ tool: "cron_delete", args: auditArgs, outcome: "error", detail: "no matching job" });
              return {
                content: [{ type: "text", text: `❌ No cron job found matching: ${command}` }],
                isError: true,
              };
            }
            await installCrontab(filtered.join("\n"));
            auditLog({ tool: "cron_delete", args: auditArgs, outcome: "ok" });
            return { content: [{ type: "text", text: `✅ Deleted cron job matching: ${command}` }] };
          }

          // Delete by id
          const entries: Array<{ lineStart: number; lineEnd: number; idx: number }> = [];
          let idx = 1;
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith("#")) continue;
            const parts = line.split(/\s+/);
            if (parts.length >= 6) {
              // Also delete the previous line if it is a junis comment
              const prevIsComment = i > 0 && lines[i - 1].trim().startsWith("#");
              entries.push({ lineStart: prevIsComment ? i - 1 : i, lineEnd: i, idx: idx++ });
            }
          }

          const target = entries.find(e => e.idx === id);
          if (!target) {
            auditLog({ tool: "cron_delete", args: auditArgs, outcome: "error", detail: "no matching job" });
            return {
              content: [{ type: "text", text: `❌ No cron job found with id=${id}. Use cron_list to see current IDs.` }],
              isError: true,
            };
          }

          const filtered = lines.filter((_, i) => i < target.lineStart || i > target.lineEnd);
          await installCrontab(filtered.join("\n"));
          auditLog({ tool: "cron_delete", args: auditArgs, outcome: "ok" });

          return { content: [{ type: "text", text: `✅ Deleted cron job #${id}` }] };
        } catch (err) {
          auditLog({ tool: "cron_delete", args: auditArgs, outcome: "error", detail: (err as Error).message });
          return {
            content: [{ type: "text", text: `❌ Failed to delete cron job: ${(err as Error).message}` }],
            isError: true,
          };
        }
      }
    );

    // share_file
    server.tool(
      "share_file",
      [
        "Upload a local file to cloud storage and return a downloadable URL.",
        "",
        "Use this tool when:",
        "- The user wants to see, receive, or download any file (including text files like .py, .js, etc.)",
        "- The user wants to share a file",
        "- The file is binary (PDF, images, audio, video, archives, etc.)",
        "",
        "Use read_file instead ONLY when the user explicitly wants to see the text contents/code inside a file",
        "in the conversation (e.g. \"show me the code\", \"what's in this file\", \"read this file\").",
      ].join("\n"),
      {
        path: z.string().describe("Absolute or relative file path to share"),
      },
      async ({ path: filePath }) => {
        enforcePolicy("share_file", { path: filePath });
        try {
          await assertFileSize(filePath);
          const buffer = await fs.readFile(filePath);
          const base64 = buffer.toString("base64");
          const filename = path.basename(filePath);

          // MIME type detection from extension
          const extMimeMap: Record<string, string> = {
            ".py": "text/x-python; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".ts": "text/typescript; charset=utf-8",
            ".jsx": "text/javascript; charset=utf-8", ".tsx": "text/typescript; charset=utf-8",
            ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
            ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
            ".xml": "application/xml; charset=utf-8", ".yaml": "text/yaml; charset=utf-8", ".yml": "text/yaml; charset=utf-8",
            ".sh": "text/x-shellscript; charset=utf-8", ".bash": "text/x-shellscript; charset=utf-8",
            ".pdf": "application/pdf",
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
            ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
            ".zip": "application/zip", ".tar": "application/x-tar",
            ".gz": "application/gzip",
            ".doc": "application/msword",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xls": "application/vnd.ms-excel",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          };
          const ext = path.extname(filePath).toLowerCase();
          const contentType = extMimeMap[ext] || "application/octet-stream";

          // __SHARE__ prefix: relay and backend detect this and always upload
          // Format: __SHARE__:<filename>:<contentType>:<base64>
          const sharePayload = `__SHARE__:${filename}:${contentType}:${base64}`;
          auditLog({ tool: "share_file", args: summarizeArgs("share_file", { path: filePath }), outcome: "ok", detail: `${buffer.length} bytes` });

          return { content: [{ type: "text", text: sharePayload }] };
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          auditLog({ tool: "share_file", args: summarizeArgs("share_file", { path: filePath }), outcome: "error", detail: e.message });
          if (e.code === "ENOENT") {
            return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }], isError: true };
          }
          return { content: [{ type: "text", text: `❌ Failed to read file: ${e.message}` }], isError: true };
        }
      }
    );
  }
}
