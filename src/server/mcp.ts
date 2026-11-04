// src/server/mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FilesystemTools } from "../tools/filesystem.js";
import { BrowserTools } from "../tools/browser.js";
import { NotebookTools } from "../tools/notebook.js";
import { DeviceTools } from "../tools/device.js";
import { ensurePeekaboo } from "../setup/peekaboo-installer.js";
import { DesktopTools } from "../tools/desktop.js";
import { toolPermissions, checkPermission } from './permissions.js';
import { RelayClient } from "../relay/client.js";
import { listenLocalHttpServer, type LocalHttpServerHandle } from "./http.js";
import { setRelayTarget, handleMCPRequest } from "./loopback-client.js";
import { VERSION } from "./version.js";

// Browser tools are created once globally because Playwright initialization is expensive
let globalBrowserTools: BrowserTools | null = null;
let desktopToolsEnabled = false;

let globalRelayClient: RelayClient | null = null;

export function setRelayClient(client: RelayClient): void {
  globalRelayClient = client;
}

/**
 * Factory that returns a new McpServer with a fresh set of tool registrations per request.
 *
 * In the MCP SDK's stateless mode a new StreamableHTTPServerTransport must be created per request,
 * so the McpServer connected to that transport is created per request too.
 *
 * BrowserTools uses Playwright internally and is expensive to initialize, so the global
 * instance is reused and only re-registered on each McpServer.
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "junis",
    version: VERSION,
  });

  // Register file/shell tools (no instance cost)
  const fsTools = new FilesystemTools();
  fsTools.register(server, globalRelayClient ?? undefined);

  // Register browser tools (reuses the global instance)
  if (globalBrowserTools) {
    globalBrowserTools.register(server);
  }

  // Register notebook tools
  const notebookTools = new NotebookTools();
  notebookTools.register(server);

  // Register device tools
  const deviceTools = new DeviceTools();
  deviceTools.register(server);

  // Register desktop tools (macOS with peekaboo installed only)
  if (desktopToolsEnabled) {
    const desktopTools = new DesktopTools();
    desktopTools.register(server);
  }

  return server;
}

export interface StartMCPServerOptions {
  /** Bind address. Defaults to 127.0.0.1 (loopback); any other address requires a token. */
  host?: string;
  /** Bearer token required on POST /mcp. */
  token?: string;
}

let currentHandle: LocalHttpServerHandle | null = null;

/** The most recently started local server (host, actual port, whether a token is set). */
export function getLocalServerInfo(): { host: string; port: number; token?: string } | null {
  return currentHandle ? { host: currentHandle.host, port: currentHandle.port, token: currentHandle.token } : null;
}

export async function startMCPServer(port: number, opts: StartMCPServerOptions = {}): Promise<number> {
  // Initialize the global browser tools (once)
  globalBrowserTools = new BrowserTools();
  await globalBrowserTools.init();

  // Check for Peekaboo (macOS only)
  desktopToolsEnabled = await ensurePeekaboo();
  if (desktopToolsEnabled) {
    console.log("✅ Peekaboo available — desktop tools enabled");
  }

  const handle = await listenLocalHttpServer(port, {
    host: opts.host,
    token: opts.token,
    createMcpServer,
  });
  currentHandle = handle;

  // Relay loopback calls use the same host, port and token
  setRelayTarget({ host: handle.host, port: handle.port, token: handle.token });

  // Clean up on process exit
  const cleanup = async () => {
    if (globalBrowserTools) {
      await globalBrowserTools.cleanup();
    }
    await handle.close();
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  return handle.port;
}

export { handleMCPRequest, toolPermissions, checkPermission };
