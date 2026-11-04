// src/setup/peekaboo-installer.ts
import { execFile } from "child_process";
import { promisify } from "util";
import { platform } from "os";

const execFileAsync = promisify(execFile);

interface PermissionInfo {
  name: string;
  isRequired: boolean;
  isGranted: boolean;
  grantInstructions: string;
}

interface PermissionsResult {
  source: string; // "local" | "bridge"
  permissions: PermissionInfo[];
}

// ── Permission check via peekaboo CLI ──────────────────────────

async function checkPermissions(): Promise<PermissionsResult> {
  const { stdout } = await execFileAsync("peekaboo", ["permissions", "--json"], {
    timeout: 10000,
  });
  const parsed = JSON.parse(stdout);
  return {
    source: parsed.data.source,
    permissions: parsed.data.permissions,
  };
}

// ── Context detection ──────────────────────────────────────────

/**
 * If TERM_PROGRAM is set, the terminal app is the TCC "responsible process";
 * otherwise a non-terminal app (Claude Desktop etc.) spawned the process.
 */
function isTerminalContext(): boolean {
  return !!process.env.TERM_PROGRAM;
}

/** stdout is a TTY, so the user is watching the console and a countdown makes sense */
function isInteractive(): boolean {
  return !!process.stdout.isTTY;
}

function detectTerminalApp(): string {
  const term = process.env.TERM_PROGRAM ?? "";
  const map: Record<string, string> = {
    ghostty: "Ghostty",
    Apple_Terminal: "Terminal",
    "iTerm.app": "iTerm2",
    WarpTerminal: "Warp",
    vscode: "Visual Studio Code",
  };
  return map[term] ?? (term || "your terminal app");
}

// ── System Settings URL for a given permission name ────────────

const SETTINGS_URL: Record<string, string> = {
  Accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "Screen Recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

async function openSettingsFor(permName: string): Promise<void> {
  const url = SETTINGS_URL[permName];
  if (url) {
    await execFileAsync("open", [url]).catch(() => {});
  }
}

// ── Trigger native macOS permission dialog ──────────────────
// Call the system API via swift -e: shows the native dialog and adds the app to the Settings list automatically
// The dialog is shown for the responsible process (the terminal app)

const PERMISSION_TRIGGER: Record<string, string> = {
  Accessibility:
    "import ApplicationServices; " +
    "let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary; " +
    "AXIsProcessTrustedWithOptions(opts)",
  "Screen Recording":
    "import CoreGraphics; CGRequestScreenCaptureAccess()",
};

async function triggerPermissionPrompt(permName: string): Promise<void> {
  const code = PERMISSION_TRIGGER[permName];
  if (!code) return;
  try {
    await execFileAsync("swift", ["-e", code], { timeout: 15000 });
  } catch {
    // swift failed: fall back to opening Settings
  }
}

// ── Poll until a specific permission is granted ─────────────

async function waitForPermission(
  permName: string,
  totalSeconds: number,
  openSettingsAfterSec: number,
): Promise<boolean> {
  const pollInterval = 5; // seconds between peekaboo checks
  let settingsOpened = false;

  for (let elapsed = 0; elapsed < totalSeconds; elapsed++) {
    process.stdout.write(`\r   ⏳ ${totalSeconds - elapsed}s remaining...`);

    // In case the dialog was denied or ignored: open the Settings pane automatically
    if (!settingsOpened && elapsed >= openSettingsAfterSec) {
      await openSettingsFor(permName);
      settingsOpened = true;
    }

    // Re-check peekaboo permissions every pollInterval
    if (elapsed > 0 && elapsed % pollInterval === 0) {
      try {
        const { permissions } = await checkPermissions();
        const perm = permissions.find((p) => p.name === permName);
        if (perm && perm.isGranted) {
          process.stdout.write("\r" + " ".repeat(30) + "\r");
          return true;
        }
      } catch {
        // Check failed: keep waiting
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  process.stdout.write("\r" + " ".repeat(30) + "\r");
  return false;
}

// ── Guide: terminal app permissions (one at a time) ─────────

async function guideTerminalPermissions(missing: PermissionInfo[]): Promise<void> {
  const termApp = detectTerminalApp();

  if (!isInteractive()) {
    // Non-interactive: print instructions only and return
    console.log(`⚠️  Desktop tools need permissions for '${termApp}'.`);
    for (const p of missing) {
      console.log(`   Missing: ${p.name} → ${p.grantInstructions}`);
    }
    console.log("   Grant permissions and restart to enable desktop tools.");
    return;
  }

  // Interactive: handle permissions one at a time
  // macOS System Settings can show only one pane at a time
  for (const perm of missing) {
    console.log(`⚠️  '${termApp}' needs ${perm.name} permission.`);
    console.log(`   → ${perm.grantInstructions}`);

    // Step 1: trigger the native dialog (adds the app to the list automatically)
    await triggerPermissionPrompt(perm.name);

    // Step 2: poll for 60 seconds (open Settings automatically after 10 seconds)
    const granted = await waitForPermission(perm.name, 60, 10);

    if (granted) {
      console.log(`   ✅ ${perm.name} granted!`);
    } else {
      console.log(`   ⚠️  ${perm.name} not granted. Desktop tools may not work correctly.`);
    }
  }
}

// ── Guide: bridge host app permissions (bridge connected) ──────

function guideBridgeHostPermissions(missing: PermissionInfo[]): void {
  const missingNames = missing.map((p) => p.name).join(", ");
  console.log("⚠️  Bridge connected but permissions missing on the host app.");
  console.log(`   Missing: ${missingNames}`);
  for (const p of missing) {
    console.log(`   → ${p.grantInstructions}`);
  }
  console.log(
    "   Grant these permissions to the bridge host app (Peekaboo.app / Claude.app), then restart."
  );
}

// ── Guide: no bridge, no terminal — need bridge setup ──────────

function guideBridgeSetup(missing: PermissionInfo[]): void {
  const missingNames = missing.map((p) => p.name).join(", ");
  console.log("⚠️  Desktop tools need permissions (running in background mode).");
  console.log(`   Missing: ${missingNames}`);
  console.log("");
  console.log("   CLI tools in background mode need a bridge host app for macOS permissions.");
  console.log("   Peekaboo auto-discovers these bridge hosts (in order):");
  console.log("     1. Peekaboo.app  → https://github.com/steipete/Peekaboo/releases");
  console.log("     2. Claude.app    → Claude Desktop (if already installed)");
  console.log("");
  console.log("   Steps:");
  console.log("     a) Launch the bridge host app");
  console.log(
    "     b) Grant it Screen Recording + Accessibility in System Settings > Privacy & Security"
  );
  console.log("     c) Restart this MCP server — peekaboo will auto-connect to the bridge");
}

// ── Main: three-way routing based on peekaboo's own source field ──

async function checkAndGuidePermissions(): Promise<void> {
  try {
    const { source, permissions } = await checkPermissions();
    const missing = permissions.filter((p) => p.isRequired && !p.isGranted);
    if (missing.length === 0) return;

    if (source === "bridge") {
      // peekaboo checked through the bridge and permissions are missing: the bridge host app needs them
      guideBridgeHostPermissions(missing);
    } else if (isTerminalContext()) {
      // Local check in a terminal: tell the user to grant permissions to the terminal app
      await guideTerminalPermissions(missing);
    } else {
      // Local check outside a terminal: the bridge needs to be set up
      guideBridgeSetup(missing);
    }
  } catch {
    // A failing permission check does not affect server startup
  }
}

// ── Public API ─────────────────────────────────────────────────

/** Auto-install of peekaboo via Homebrew is on by default; JUNIS_NO_AUTO_INSTALL=1 (or true/yes) turns it off. */
export function shouldAutoInstall(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.JUNIS_NO_AUTO_INSTALL ?? "").trim().toLowerCase();
  return !(v === "1" || v === "true" || v === "yes" || v === "on");
}

/**
 * Check whether the peekaboo CLI is installed and install it automatically (macOS only).
 * After installing, guide the user based on peekaboo's permission check result (including source):
 * - source="bridge" + missing permissions → permissions for the bridge host app
 * - source="local" + terminal → permissions for the terminal app
 * - source="local" + non-terminal → bridge setup
 * @returns true if desktop tools can be registered, false otherwise
 */
export async function ensurePeekaboo(): Promise<boolean> {
  if (platform() !== "darwin") return false;

  try {
    await execFileAsync("which", ["peekaboo"]);
  } catch {
    // peekaboo not installed: try brew (skipped when JUNIS_NO_AUTO_INSTALL=1)
    if (!shouldAutoInstall()) {
      console.log("ℹ️  peekaboo not found and JUNIS_NO_AUTO_INSTALL is set — desktop tools disabled. Install manually: brew tap steipete/tap && brew install peekaboo");
      return false;
    }
    console.log("ℹ️  peekaboo (macOS desktop automation) is not installed. Installing with Homebrew: brew tap steipete/tap && brew install peekaboo — set JUNIS_NO_AUTO_INSTALL=1 to skip this.");
    try {
      await execFileAsync("brew", ["tap", "steipete/tap"], { timeout: 30000 });
      await execFileAsync("brew", ["install", "peekaboo"], { timeout: 120000 });
      console.log("✅ peekaboo installed");
    } catch (brewErr) {
      console.warn("⚠️  peekaboo install failed:", (brewErr as Error).message);
      console.warn(
        "   Desktop tools disabled. Install manually: brew tap steipete/tap && brew install peekaboo"
      );
      return false;
    }
  }

  // Three-way permission guidance based on peekaboo's source
  await checkAndGuidePermissions();
  return true;
}
