#!/usr/bin/env node
// src/cli/index.ts
import { program } from "commander";
import { select } from "@inquirer/prompts";
import { loadConfig, saveConfig, clearConfig, loadLocalServerSettings, saveLocalServerSettings, secureConfigDir, JunisConfig } from "./config.js";
import { authenticate, ensureTeam, revokeDevice } from "./auth.js";
import { RelayClient } from "../relay/client.js";
import { startMCPServer, handleMCPRequest, setRelayClient } from "../server/mcp.js";
import { startStdioServer } from "../server/stdio.js";
import { resolveLocalServerSettings, generateLocalToken, type ResolvedLocalServer } from "../server/local-settings.js";
import { DEFAULT_HOST, DEFAULT_PORT, displayHost, formatHostForUrl, isLoopbackHost, isUnspecifiedHost, listInterfaceAddresses } from "../server/http.js";
import { runLogout } from "./logout.js";
import { execSync } from "child_process";
import { isRunning, startDaemon, stopDaemon, writePid, ServiceManager } from "./daemon.js";
import { enforceEndpointsAtStartup, webUrlForDisplay } from "./endpoints.js";
import { VERSION as version } from "../server/version.js";
import notifier from "node-notifier";

/**
 * Server URL guard — every mode that talks to the server (login, relay, logout) runs this first.
 * A refused JUNIS_API_URL / JUNIS_WS_URL / JUNIS_WEB_URL prints why and exits 1; a custom server
 * accepted with JUNIS_ALLOW_CUSTOM_SERVER=1 prints one red warning naming the host.
 */
function guardServerUrls(): void {
  enforceEndpointsAtStartup({
    env: process.env,
    error: (line) => console.error(line),
    exit: (code) => process.exit(code),
  });
}

/**
 * Desktop notification for daemon mode (best effort).
 * The daemon has no terminal, so without this the only place a "sign in again" message could go is the log,
 * which nobody reads, and the device would silently stay offline. Notification failures are ignored.
 */
function notifyUser(title: string, message: string): void {
  try {
    notifier.notify({ title, message });
  } catch {
    /* notifications unavailable; ignore */
  }
}

program
  .name("junis")
  .description("Give AI agents a computer to work on: a local MCP server and the junis.ai device relay")
  .version(version);

function getSystemInfo(): string {
  const platform = process.platform;
  if (platform === "darwin") {
    try {
      const sw = execSync("sw_vers -productVersion", { encoding: "utf8" }).trim();
      const hw = execSync("sysctl -n machdep.cpu.brand_string", { encoding: "utf8" }).trim();
      return `macOS ${sw} (${hw})`;
    } catch {
      return "macOS";
    }
  }
  if (platform === "win32") return "Windows";
  return "Linux";
}

function getDeviceName(): string {
  const platform = process.platform;
  if (platform === "darwin") return "Mac";
  if (platform === "win32") return "Windows PC";
  return "Linux PC";
}

function printBanner(): void {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║                                              ║");
  const versionLabel = `🦞 J U N I S  v${version}`;
  // 🦞 is a UTF-16 surrogate pair (length 2) and occupies 2 terminal columns, so length needs no extra correction
  const padding = " ".repeat(46 - 3 - versionLabel.length);
  console.log(`║   ${versionLabel}${padding}║`);
  console.log("║                                              ║");
  console.log("║   Device Agent for AI Teams                  ║");
  console.log("║                                              ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
}

function printStep1(): void {
  const sysInfo = getSystemInfo();
  console.log("─────────────────────────────────────────────────────");
  console.log(" STEP 1 · Initializing Device");
  console.log("─────────────────────────────────────────────────────");
  console.log(` ◉ Scanning system ............... ${sysInfo}`);
  console.log(" ◉ Loading MCP tools");
  console.log("   ├── file_system    files, directories, search    ✅ ready");
  console.log("   ├── shell          terminal commands, processes  ✅ ready");
  console.log("   ├── browser        web automation via Playwright ✅ ready");
  console.log("   ├── notebook       Jupyter cell editing          ✅ ready");
  console.log("   └── device         camera, screen, alerts        ✅ ready");
  console.log("");
}

function endpointUrl(host: string, port: number): string {
  return `http://${displayHost(host)}:${port}/mcp`;
}

/**
 * Print the local MCP endpoint. When `resolved` is true the port is the bound port (after listen);
 * when false it is the requested value (background mode, where the daemon binds separately and logs the actual port).
 */
function printEndpoint(local: ResolvedLocalServer, resolved: boolean): void {
  const url = endpointUrl(local.host, local.port);
  console.log(` ◉ Local MCP endpoint ........... ${url}${resolved ? "" : "  (requested — see ~/.junis/logs/junis.log for the bound port)"}`);
  if (isLoopbackHost(local.host)) {
    console.log(` ◉ Bind address ................. ${formatHostForUrl(local.host)}:${local.port} (loopback only — use --host to expose)`);
  } else {
    console.log(` ◉ Bind address ................. ${formatHostForUrl(local.host)}:${local.port} ⚠️  reachable from other machines`);
    if (isUnspecifiedHost(local.host)) {
      const ips = listInterfaceAddresses("IPv4");
      if (ips.length > 0) {
        console.log(`   Reachable at ................. ${ips.map((ip) => `http://${ip}:${local.port}/mcp`).join("  ")}`);
      }
    }
  }
  if (local.token) {
    if (local.generated) {
      console.log(` ◉ Bearer token (NEW) ........... ${local.token}`);
      console.log("   Shown once. Saved to ~/.junis/config.json (local_token) — every request must send it:");
    } else {
      console.log(" ◉ Bearer token ................. required (configured in ~/.junis/config.json)");
    }
    console.log(`   claude mcp add --transport http junis-device ${url} --header "Authorization: Bearer ${local.generated ? local.token : "<token>"}"`);
  }
  console.log("");
}

/**
 * Resolve the binding from --host/--port/--token flags plus config local_*, and remember flag values in the config.
 * Generates a token here when binding to a non-loopback address without one (printEndpoint prints it once).
 */
function resolveLocalServerForRun(
  options: { host?: string; port?: string; token?: string | false },
  opts: { daemon: boolean }
): ResolvedLocalServer {
  let portFlag: number | undefined;
  if (options.port !== undefined) {
    portFlag = Number(options.port);
    if (!Number.isInteger(portFlag) || portFlag < 1 || portFlag > 65535) {
      console.error(`❌ Invalid --port value: ${options.port} (1-65535)`);
      process.exit(1);
    }
  }
  let local: ResolvedLocalServer;
  try {
    local = resolveLocalServerSettings(
      { host: options.host, port: portFlag, token: options.token },
      loadLocalServerSettings(),
      opts.daemon ? {} : { generateToken: generateLocalToken },
    );
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }
  for (const w of local.warnings) console.warn(`⚠️  ${w}`);
  // The daemon only reads the config: it takes no flags, so there is nothing to remember
  if (!opts.daemon && Object.keys(local.persist).length > 0) {
    try {
      saveLocalServerSettings(local.persist);
    } catch (e) {
      console.warn(`⚠️  Could not save local server settings: ${(e as Error).message}`);
    }
  }
  return local;
}

/**
 * Check that the device and team are valid before connecting the relay.
 * - "ready": continue
 * - "created": update config.token and continue
 * - "auth_expired" / "device_not_found": delete the config; re-authentication required
 * - network error: ignore and try the relay connection anyway
 *
 * @returns a valid config, or null if re-authentication is required
 */
async function checkEnsureTeam(
  config: JunisConfig,
  label: string,
): Promise<JunisConfig | null> {
  try {
    const result = await ensureTeam(config.device_key, config.token);
    if (result.status === "ready") {
      return config;
    }
    if (result.status === "created") {
      console.log(`[${label}] Team restored automatically`);
      if (result.token) {
        config.token = result.token;
        saveConfig(config);
      }
      return config;
    }
    // auth_expired or device_not_found: re-authentication required
    console.log(`[${label}] ${result.status} — re-authentication required`);
    clearConfig();
    return null;
  } catch {
    // Network error (e.g. server down): continue so the relay can reconnect
    return config;
  }
}

async function runForeground(config: JunisConfig, local: ResolvedLocalServer): Promise<void> {
  const deviceName = config.device_name;
  const platformName = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

  const actualPort = await startMCPServer(local.port, { host: local.host, token: local.token });

  console.log("─────────────────────────────────────────────────────");
  console.log(" STEP 5 · Starting Foreground Service");
  console.log("─────────────────────────────────────────────────────");
  console.log(` ◉ MCP server started ........... ${formatHostForUrl(local.host)}:${actualPort}`);
  printEndpoint({ ...local, port: actualPort }, true);

  const relay = new RelayClient(config, handleMCPRequest, async () => {
    console.log("[junis] Session expired - re-authentication required");
    try {
      let waitingPrinted = false;
      const authResult = await authenticate(
        deviceName,
        platformName,
        (uri) => {
          console.log(`[junis] Browser re-auth: ${uri}`);
        },
        () => { if (!waitingPrinted) waitingPrinted = true; },
        config.device_key,
        config.token,
        config.device_key,
      );
      config.token = authResult.token;
      saveConfig(config);
      relay.restart();
    } catch (e) {
      console.error("[junis] Re-authentication failed:", e);
      process.exit(1);
    }
  });
  setRelayClient(relay);
  await relay.connect();

  const webUrl = webUrlForDisplay(process.env);
  console.log(" ◉ Relay connected");
  console.log("");
  console.log("─────────────────────────────────────────────────────");
  console.log(" ✅ ALL SET — Junis is running in the foreground.");
  console.log("    Press Ctrl+C to stop.");
  console.log("─────────────────────────────────────────────────────");
  console.log("");
  console.log(` → ${webUrl}`);
  console.log("");

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[junis] Shutting down...");
    relay.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runBackground(config: JunisConfig, local: ResolvedLocalServer): Promise<void> {
  // config parameter is kept for API consistency; config is already saved before calling this function
  void config;

  console.log("─────────────────────────────────────────────────────");
  console.log(" STEP 5 · Starting Background Service");
  console.log("─────────────────────────────────────────────────────");

  // The daemon takes no flags and binds to the same host/port/token from config (local_*); flag values were saved above
  const svc = new ServiceManager();
  let serviceInstalled = false;
  try {
    await svc.install();
    serviceInstalled = true;
    console.log(" ◉ Service registered ........... ✅");
    console.log(" ◉ Auto-start on boot ........... ✅");
  } catch (e) {
    console.warn(` ⚠️  Service registration failed: ${(e as Error).message}`);
    console.warn("    Running as background process only.");
    startDaemon();
  }
  printEndpoint(local, false);

  const webUrl = webUrlForDisplay(process.env);
  console.log("");
  console.log("─────────────────────────────────────────────────────");
  console.log(" ✅ ALL SET — Junis is running in the background.");
  if (serviceInstalled) {
    console.log("    Auto-starts on boot.");
  } else {
    console.log("    ⚠️  Auto-start on boot is NOT enabled (service registration failed).");
    console.log("    Run 'npx junis stop' and try 'npx junis' again to retry.");
  }
  console.log("─────────────────────────────────────────────────────");
  console.log("");
  console.log(` → ${webUrl}`);
  console.log("");
  console.log("   To stop: npx junis stop");
  console.log("");

  // Exit the foreground process (the daemon takes over)
  process.exit(0);
}

program
  .command("start", { isDefault: true })
  .description("Start Junis agent connection")
  .option("--local", "Run local MCP server only (no cloud connection)")
  .option("--port <number>", `Local MCP server port (default: ${DEFAULT_PORT}; remembered in ~/.junis/config.json)`)
  .option("--host <addr>", `Bind address (default: ${DEFAULT_HOST}, loopback only). Any other address requires a bearer token (--token or auto-generated, printed once)`)
  .option("--token <value>", "Bearer token required on every POST /mcp (Authorization: Bearer <value>). Remembered in ~/.junis/config.json")
  .option("--no-token", "Forget a remembered token (loopback only)")
  .option("--reset", "Clear existing credentials and re-login")
  .option("--daemon", "Run in daemon mode (internal, used by launchd/systemd)")
  .option("--foreground", "Run in foreground mode (no prompt)")
  .option("--stdio", "Run as stdio transport (for MCP client integration)")
  .action(async (options) => {
    // --stdio: run the MCP server over stdio transport (highest priority)
    // stdout carries MCP traffic, so no banner or console.log output
    if (options.stdio) {
      await startStdioServer();
      return;
    }

    // Narrow ~/.junis from older installs (0755) to owner-only, including runs that never rewrite the config (e.g. daemon restarts)
    secureConfigDir();

    // Resolve the local server binding (flags > config > default 127.0.0.1:3000). The daemon reads config only.
    const local = resolveLocalServerForRun(options, { daemon: Boolean(options.daemon) });


    // --foreground: run in the foreground immediately, without prompts
    if (options.foreground) {
      guardServerUrls();
      printBanner();

      const existingConfig = loadConfig();
      let config = options.reset ? null : existingConfig;

      const deviceName = config?.device_name
        ?? `${process.env["USER"] ?? "user"}'s ${getDeviceName()}`;
      const platformName =
        process.platform === "darwin" ? "macos" :
        process.platform === "win32" ? "windows" : "linux";

      printStep1();

      if (!config) {
        let waitingPrinted = false;
        const authResult = await authenticate(
          deviceName,
          platformName,
          (uri) => {
            console.log("─────────────────────────────────────────────────────");
            console.log(" STEP 2 · Connect to Junis Cloud");
            console.log("─────────────────────────────────────────────────────");
            console.log(" Opening browser...");
            console.log(` → ${uri}`);
            process.stdout.write(" Waiting for login ·");
          },
          () => {
            if (!waitingPrinted) { waitingPrinted = true; } else { process.stdout.write("·"); }
          },
          existingConfig?.device_key,
          existingConfig?.token,
          existingConfig?.device_key,
        );
        console.log("");
        console.log(` ✅ Authenticated as ${authResult.email ?? "your account"}`);
        console.log("");

        config = {
          device_key: authResult.device_key,
          token: authResult.token,
          device_name: deviceName,
          created_at: new Date().toISOString(),
        };
        saveConfig(config);

        console.log("─────────────────────────────────────────────────────");
        console.log(" STEP 3 · Register Device");
        console.log("─────────────────────────────────────────────────────");
        console.log(` ◉ Device name .................. ${deviceName}`);
        console.log(` ◉ Device key ................... ${authResult.device_key}`);
        console.log(` ◉ Cloud relay connected ........ wss://junis.ai/ws/devices/${authResult.device_key}`);
        console.log(" ◉ Status ....................... 🟢 online");
        console.log("");

        if (authResult.agent_id) {
          const workspaceName = `${deviceName} Workspace`;
          console.log("─────────────────────────────────────────────────────");
          console.log(" STEP 4 · Create AI Team");
          console.log("─────────────────────────────────────────────────────");
          console.log(` ◉ Workspace created ............ ${workspaceName}`);
          console.log(` ◉ Agent created ................ ${authResult.agent_name}`);
          console.log(` ◉ Device linked ................ ${deviceName} → ${authResult.agent_name}`);
          console.log(" ◉ Tools assigned ............... call_device_mcp, list_device_mcp_tools");
          console.log("");
        }
      } else {
        // Config exists: check device and team before connecting the relay
        const oldDeviceKey = config.device_key;
        const oldToken = config.token;
        const checked = await checkEnsureTeam(config, "junis");
        if (!checked) {
          // Re-authentication required: pass the existing device_key to reuse the device
          let waitingPrinted = false;
          const authResult = await authenticate(
            deviceName,
            platformName,
            (uri) => {
              console.log("─────────────────────────────────────────────────────");
              console.log(" STEP 2 · Connect to Junis Cloud");
              console.log("─────────────────────────────────────────────────────");
              console.log(" Opening browser...");
              console.log(` → ${uri}`);
              process.stdout.write(" Waiting for login ·");
            },
            () => {
              if (!waitingPrinted) { waitingPrinted = true; } else { process.stdout.write("·"); }
            },
            oldDeviceKey,
            oldToken,
            oldDeviceKey,
          );
          console.log("");
          console.log(` ✅ Authenticated as ${authResult.email ?? "your account"}`);
          console.log("");

          config = {
            device_key: authResult.device_key,
            token: authResult.token,
            device_name: deviceName,
            created_at: new Date().toISOString(),
          };
          saveConfig(config);
        }

        console.log("─────────────────────────────────────────────────────");
        console.log(" STEP 3 · Register Device");
        console.log("─────────────────────────────────────────────────────");
        console.log(` ◉ Device name .................. ${config.device_name}`);
        console.log(` ◉ Device key ................... ${config.device_key}`);
        console.log(` ◉ Cloud relay connected ........ wss://junis.ai/ws/devices/${config.device_key}`);
        console.log(" ◉ Status ....................... 🟢 online");
        console.log("");
      }

      await runForeground(config, local);
      return;
    }

    // --daemon: the actual background process started by launchd/systemd
    if (options.daemon) {
      // Write the PID file on daemon start so `npx junis stop` can find the process
      writePid(process.pid);

      if (options.local) {
        const p = await startMCPServer(local.port, { host: local.host, token: local.token });
        console.log(`[junis daemon] MCP server listening on ${formatHostForUrl(local.host)}:${p}${local.token ? " (bearer token required)" : ""}`);
        return;
      }

      guardServerUrls();
      const existingConfig = loadConfig();
      let config = options.reset ? null : existingConfig;
      if (!config) {
        // No credentials in daemon mode: exit (authentication happens in the foreground)
        console.error("❌ No credentials found. Run npx junis first.");
        process.exit(1);
      }

      // Check device and team before connecting the relay
      const checked = await checkEnsureTeam(config, "junis daemon");
      if (!checked) {
        // Browser auth is impossible in daemon mode: notify the user and exit
        // (launchd KeepAlive restarts would hit the same path; without a notification the device stays offline silently)
        notifyUser(
          "Junis: sign-in required",
          "Device authentication expired and the connection stopped. Run npx junis in a terminal to sign in again."
        );
        console.error("❌ Device or team invalid. Run npx junis --reset to re-authenticate.");
        process.exit(1);
      }
      config = checked;

      const deviceName = config.device_name;
      const platformName = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

      const actualPort = await startMCPServer(local.port, { host: local.host, token: local.token });
      console.log(`[junis daemon] MCP server listening on ${formatHostForUrl(local.host)}:${actualPort}${local.token ? " (bearer token required)" : ""}`);

      const relay = new RelayClient(config, handleMCPRequest, async () => {
        console.log("[junis daemon] Session expired - re-authentication required");
        // The LaunchAgent runs in the GUI session, so the browser does open, but a user who doesn't know why
        // tends to close it; the notification gives context (best effort).
        notifyUser(
          "Junis: sign-in required",
          "Device session expired. Approve the sign-in in the browser window that just opened."
        );
        try {
          let waitingPrinted = false;
          const authResult = await authenticate(
            deviceName,
            platformName,
            (uri) => {
              console.log(`[junis daemon] Browser re-auth: ${uri}`);
            },
            () => { if (!waitingPrinted) waitingPrinted = true; },
            config!.device_key,
            config!.token,
            config!.device_key,
          );
          config!.token = authResult.token;
          saveConfig(config!);
          relay.restart();
        } catch (e) {
          notifyUser(
            "Junis disconnected",
            "Sign-in was not completed, so the device connection stopped. Run npx junis in a terminal."
          );
          console.error("[junis daemon] Re-authentication failed:", e);
          process.exit(1);
        }
      });
      setRelayClient(relay);
      await relay.connect();
      console.log("[junis daemon] relay connected");
      return;
    }

    // --local: run only the local MCP server
    if (options.local) {
      printBanner();
      const actualPort = await startMCPServer(local.port, { host: local.host, token: local.token });
      printStep1();
      printEndpoint({ ...local, port: actualPort }, true);
      console.log("─────────────────────────────────────────────────────");
      console.log(" ✅ ALL SET — Local MCP server is running");
      console.log("─────────────────────────────────────────────────────");
      return;
    }

    // Interactive mode: none of the flags above were given
    guardServerUrls();
    printBanner();

    // Check whether it is already running
    const { running, pid } = isRunning();
    if (running) {
      console.log(`✅ Junis is running. (PID: ${pid})`);
      console.log("   To stop: npx junis stop");
      return;
    }

    // Choose the interactive mode
    const mode: "foreground" | "background" = await select({
      message: "Select run mode:",
      choices: [
        {
          name: "Foreground",
          value: "foreground" as const,
          description: "Runs in the current terminal. Press Ctrl+C to stop.\n    Full OS access: camera, notifications, and more.",
        },
        {
          name: "Background (daemon)",
          value: "background" as const,
          description: "Runs as a background service. Stays alive after\n    closing the terminal. Auto-starts on reboot.",
        },
      ],
    });

    // Authenticate
    const existingConfig = loadConfig();
    let config = options.reset ? null : existingConfig;

    const deviceName = config?.device_name
      ?? `${process.env["USER"] ?? "user"}'s ${getDeviceName()}`;
    const platformName =
      process.platform === "darwin" ? "macos" :
      process.platform === "win32" ? "windows" : "linux";

    printStep1();

    if (!config) {
      let waitingPrinted = false;
      const authResult = await authenticate(
        deviceName,
        platformName,
        (uri) => {
          console.log("─────────────────────────────────────────────────────");
          console.log(" STEP 2 · Connect to Junis Cloud");
          console.log("─────────────────────────────────────────────────────");
          console.log(" Opening browser...");
          console.log(` → ${uri}`);
          process.stdout.write(" Waiting for login ·");
        },
        () => {
          if (!waitingPrinted) { waitingPrinted = true; } else { process.stdout.write("·"); }
        },
        existingConfig?.device_key,
        existingConfig?.token,
        existingConfig?.device_key,
      );
      console.log("");
      console.log(` ✅ Authenticated as ${authResult.email ?? "your account"}`);
      console.log("");

      config = {
        device_key: authResult.device_key,
        token: authResult.token,
        device_name: deviceName,
        created_at: new Date().toISOString(),
      };
      saveConfig(config);

      console.log("─────────────────────────────────────────────────────");
      console.log(" STEP 3 · Register Device");
      console.log("─────────────────────────────────────────────────────");
      console.log(` ◉ Device name .................. ${deviceName}`);
      console.log(` ◉ Device key ................... ${authResult.device_key}`);
      console.log(` ◉ Cloud relay connected ........ wss://junis.ai/ws/devices/${authResult.device_key}`);
      console.log(" ◉ Status ....................... 🟢 online");
      console.log("");

      if (authResult.agent_id) {
        const workspaceName = `${deviceName} Workspace`;
        console.log("─────────────────────────────────────────────────────");
        console.log(" STEP 4 · Create AI Team");
        console.log("─────────────────────────────────────────────────────");
        console.log(` ◉ Workspace created ............ ${workspaceName}`);
        console.log(` ◉ Agent created ................ ${authResult.agent_name}`);
        console.log(` ◉ Device linked ................ ${deviceName} → ${authResult.agent_name}`);
        console.log(" ◉ Tools assigned ............... call_device_mcp, list_device_mcp_tools");
        console.log("");
      }
    } else {
      // Config exists: check device and team before connecting the relay
      const oldDeviceKey = config.device_key;
      const oldToken = config.token;
      const checked = await checkEnsureTeam(config, "junis");
      if (!checked) {
        // Re-authentication required: pass the existing device_key to reuse the device
        let waitingPrinted = false;
        const authResult = await authenticate(
          deviceName,
          platformName,
          (uri) => {
            console.log("─────────────────────────────────────────────────────");
            console.log(" STEP 2 · Connect to Junis Cloud");
            console.log("─────────────────────────────────────────────────────");
            console.log(" Opening browser...");
            console.log(` → ${uri}`);
            process.stdout.write(" Waiting for login ·");
          },
          () => {
            if (!waitingPrinted) { waitingPrinted = true; } else { process.stdout.write("·"); }
          },
          oldDeviceKey,
          oldToken,
          oldDeviceKey,
        );
        console.log("");
        console.log(` ✅ Authenticated as ${authResult.email ?? "your account"}`);
        console.log("");

        config = {
          device_key: authResult.device_key,
          token: authResult.token,
          device_name: deviceName,
          created_at: new Date().toISOString(),
        };
        saveConfig(config);
      }

      console.log("─────────────────────────────────────────────────────");
      console.log(" STEP 3 · Register Device");
      console.log("─────────────────────────────────────────────────────");
      console.log(` ◉ Device name .................. ${config.device_name}`);
      console.log(` ◉ Device key ................... ${config.device_key}`);
      console.log(` ◉ Cloud relay connected ........ wss://junis.ai/ws/devices/${config.device_key}`);
      console.log(" ◉ Status ....................... 🟢 online");
      console.log("");
    }

    if (mode === "foreground") {
      await runForeground(config, local);
    } else {
      await runBackground(config, local);
    }
  });

program
  .command("stop")
  .description("Stop background service and disable auto-start")
  .action(async () => {
    const stopped = stopDaemon();  // stop via the PID file
    const svc = new ServiceManager();
    let serviceUninstalled = false;
    try {
      await svc.uninstall();  // stop and unregister the launchd/systemd service
      serviceUninstalled = true;
    } catch {
      // The service may not have been installed
    }
    if (stopped || serviceUninstalled) {
      console.log("✅ Junis service has been stopped.");
      console.log("   Auto-start has been disabled.");
    } else {
      console.log("ℹ️  No running Junis process found.");
    }
  });

program
  .command("logout")
  .description("Revoke this device on the server, stop the background service and clear credentials")
  .action(async () => {
    guardServerUrls();
    // Order: revoke on the server (best effort) → stop the daemon → unregister the service → delete the config.
    // A running daemon would rewrite the config on its next re-auth and undo the logout.
    await runLogout({
      loadConfig,
      revokeDevice,
      stopDaemon,
      uninstallService: () => new ServiceManager().uninstall(),
      clearConfig,
      log: (line) => console.log(line),
    });
  });

program
  .command("status")
  .description("Check current status")
  .action(() => {
    const config = loadConfig();
    const { running, pid } = isRunning();
    if (!config) {
      console.log("❌ Not authenticated (run npx junis)");
    } else if (running) {
      console.log(`✅ Running (PID: ${pid})`);
      console.log(`   Device: ${config.device_name}`);
      console.log(`   Registered: ${config.created_at}`);
    } else {
      console.log("⚠️  Authenticated, service stopped");
      console.log(`   Device: ${config.device_name}`);
      console.log("   To start: npx junis");
    }
    const localSettings = loadLocalServerSettings();
    if (localSettings.local_host || localSettings.local_port || localSettings.local_token) {
      const host = localSettings.local_host ?? DEFAULT_HOST;
      const port = localSettings.local_port ?? DEFAULT_PORT;
      console.log(`   Local MCP: ${endpointUrl(host, port)}${isLoopbackHost(host) ? "" : " (bind " + formatHostForUrl(host) + ")"}${localSettings.local_token ? " — bearer token required" : ""}`);
    }
  });

program.addHelpText("after", `
Examples:
  npx junis                     Interactive mode (foreground/background)
  npx junis --local             Local MCP server only (no cloud) — http://localhost:3000/mcp, loopback only
  npx junis --local --host 0.0.0.0
                                Also reachable from other machines. A bearer token is generated,
                                printed once and required on every request (Authorization header)
  npx junis --local --host 0.0.0.0 --token <secret>
                                Same, with a token you choose
  npx junis --stdio             Run as stdio MCP server for Claude Code, etc.
  npx junis stop                Stop background service
  npx junis logout              Revoke device on the server, stop the service, clear credentials
  npx junis status              Check current status

--host/--port/--token are remembered in ~/.junis/config.json (local_host/local_port/local_token) so
the background service and later runs bind the same way. --no-token forgets the token (loopback only).

MCP Client Config (Claude Code, Claude Desktop, Codex, etc.):
  {
    "mcpServers": {
      "junis-device": {
        "command": "npx",
        "args": ["-y", "junis", "--stdio"]
      }
    }
  }

HTTP transport (server started separately):
  same machine, no token:   claude mcp add --transport http junis-device http://localhost:3000/mcp
  with --host / token:      claude mcp add --transport http junis-device http://<addr>:3000/mcp \\
                              --header "Authorization: Bearer <token>"
`);

program.parse();
