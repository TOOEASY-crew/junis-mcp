// src/cli/daemon.ts
import fs from "fs";
import path from "path";
import os from "os";
import { execSync, spawn } from "child_process";
import { escapeXml, serviceEndpointEnv } from "./endpoints.js";

const CONFIG_DIR = path.join(os.homedir(), ".junis");
const PID_FILE = path.join(CONFIG_DIR, "junis.pid");
const LOG_DIR = path.join(CONFIG_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "junis.log");

// macOS LaunchAgent plist path
const PLIST_PATH = path.join(
  os.homedir(),
  "Library/LaunchAgents/ai.junis.plist"
);
// Linux systemd unit path
const SYSTEMD_PATH = path.join(
  os.homedir(),
  ".config/systemd/user/junis.service"
);

export function isRunning(): { running: boolean; pid?: number } {
  try {
    if (!fs.existsSync(PID_FILE)) return { running: false };
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (isNaN(pid)) return { running: false };
    // Check that the process exists (signal 0 only tests for existence)
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // PID file exists but the process does not: remove the stale PID file
    try { fs.unlinkSync(PID_FILE); } catch {}
    return { running: false };
  }
}

export function writePid(pid: number): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PID_FILE, String(pid), "utf-8");
}

/**
 * Plain background process, used when service registration fails.
 * Host, port and token are read from ~/.junis/config.json (local_*), as on the launchd/systemd path, so no flags are passed.
 */
export function startDaemon(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 }); // owner-only if ~/.junis is first created here

  const nodePath = process.execPath;
  const scriptPath = process.argv[1];

  const out = fs.openSync(LOG_FILE, "a");
  const err = fs.openSync(LOG_FILE, "a");

  const child = spawn(nodePath, [scriptPath, "start", "--daemon"], {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env },  // inherit the current env (JUNIS_API_URL, JUNIS_WS_URL, ...)
  });
  child.unref();

  // Wait briefly, then check the PID file
  const pid = child.pid!;
  writePid(pid);
}

export function stopDaemon(): boolean {
  const { running, pid } = isRunning();
  if (!running || !pid) return false;

  try {
    process.kill(pid, "SIGTERM");
    try { fs.unlinkSync(PID_FILE); } catch {}
    return true;
  } catch {
    return false;
  }
}

// ── Service file builders (pure — unit-tested without installing anything) ────────────────

export interface ServiceFileInput {
  nodePath: string;
  scriptPath: string;
  logFile: string;
  /** environment persisted into the service, in order (HOME, PATH, then guarded JUNIS_* values) */
  env: Record<string, string>;
}

/** launchd plist. Every value is XML-escaped so a crafted path or env value cannot inject keys. */
export function buildLaunchdPlist(input: ServiceFileInput): string {
  const envLines = Object.entries(input.env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.junis</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(input.nodePath)}</string>
    <string>${escapeXml(input.scriptPath)}</string>
    <string>start</string>
    <string>--daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envLines}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(input.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(input.logFile)}</string>
</dict>
</plist>`;
}

/** systemd `Environment="K=V"` value: no line breaks (a newline would add a directive), quotes and backslashes escaped. */
function systemdQuote(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** systemd ExecStart argument: quoted only when it contains whitespace or quotes (plain paths stay as before). */
function systemdArg(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  return /[\s"]/.test(clean) ? `"${systemdQuote(clean)}"` : clean;
}

/** systemd user unit. Values are quoted/escaped; no blank lines are left by absent variables. */
export function buildSystemdUnit(input: ServiceFileInput): string {
  const envLines = Object.entries(input.env).map(([k, v]) => `Environment="${k}=${systemdQuote(v)}"`);
  return [
    "[Unit]",
    "Description=Junis Device Agent",
    "After=network.target",
    "",
    "[Service]",
    `ExecStart=${systemdArg(input.nodePath)} ${systemdArg(input.scriptPath)} start --daemon`,
    "Restart=always",
    "RestartSec=5",
    ...envLines,
    `StandardOutput=append:${input.logFile.replace(/[\r\n]+/g, " ")}`,
    `StandardError=append:${input.logFile.replace(/[\r\n]+/g, " ")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
  ].join("\n");
}

/** Windows scheduled task: limited privileges (no elevation) and both paths quoted inside /TR. */
export function buildSchtasksCreateCommand(input: { nodePath: string; scriptPath: string }): string {
  const q = (s: string) => `\\"${s.replace(/"/g, "")}\\"`;
  return `schtasks /Create /F /TN "Junis" /TR "${q(input.nodePath)} ${q(input.scriptPath)} start --daemon" /SC ONLOGON /RL LIMITED`;
}

/** Environment persisted into the service: HOME, PATH, then only URL variables that passed the endpoint guard. */
function serviceEnvironment(): Record<string, string> {
  return {
    HOME: os.homedir(),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...serviceEndpointEnv(process.env),
  };
}

export class ServiceManager {
  private get platform() {
    if (process.platform === "darwin") return "mac";
    if (process.platform === "win32") return "win";
    return "linux";
  }

  async install(): Promise<void> {
    const nodePath = process.execPath;
    const scriptPath = process.argv[1];

    if (this.platform === "mac") {
      const plist = buildLaunchdPlist({ nodePath, scriptPath, logFile: LOG_FILE, env: serviceEnvironment() });

      fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
      fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(PLIST_PATH, plist, "utf-8");
      try {
        execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
        execSync(`launchctl load "${PLIST_PATH}"`);
      } catch (e) {
        throw new Error(`launchctl load failed: ${(e as Error).message}`);
      }

    } else if (this.platform === "linux") {
      const unit = buildSystemdUnit({ nodePath, scriptPath, logFile: LOG_FILE, env: serviceEnvironment() });

      fs.mkdirSync(path.dirname(SYSTEMD_PATH), { recursive: true });
      fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(SYSTEMD_PATH, unit, "utf-8");
      execSync("systemctl --user daemon-reload");
      execSync("systemctl --user enable junis");
      execSync("systemctl --user start junis");

    } else {
      // Windows: schtasks
      execSync(buildSchtasksCreateCommand({ nodePath, scriptPath }));
    }
  }

  async uninstall(): Promise<void> {
    if (this.platform === "mac") {
      try {
        execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
        if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
      } catch {}

    } else if (this.platform === "linux") {
      try {
        execSync("systemctl --user stop junis 2>/dev/null || true");
        execSync("systemctl --user disable junis 2>/dev/null || true");
        if (fs.existsSync(SYSTEMD_PATH)) fs.unlinkSync(SYSTEMD_PATH);
        execSync("systemctl --user daemon-reload 2>/dev/null || true");
      } catch {}

    } else {
      try {
        execSync('schtasks /Delete /F /TN "Junis" 2>nul || true');
      } catch {}
    }
  }
}
