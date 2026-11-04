#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FilesystemTools } from "../tools/filesystem.js";
import { BrowserTools } from "../tools/browser.js";
import { NotebookTools } from "../tools/notebook.js";
import { DeviceTools } from "../tools/device.js";
import { fileURLToPath } from "url";
import { VERSION } from "./version.js";

export async function startStdioServer(): Promise<void> {
  const server = new McpServer({ name: "junis", version: VERSION });

  const fsTools = new FilesystemTools();
  fsTools.register(server);

  const browserTools = new BrowserTools();
  await browserTools.init();
  browserTools.register(server);

  const notebookTools = new NotebookTools();
  notebookTools.register(server);

  const deviceTools = new DeviceTools();
  deviceTools.register(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await browserTools.cleanup();
    process.exit(0);
  });
}

// When run directly (not imported as a module)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startStdioServer().catch(console.error);
}
