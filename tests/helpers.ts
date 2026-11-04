// tests/helpers.ts: shared test utilities (real HTTP requests, minimal McpServer)
import http from "http";
import { networkInterfaces } from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Minimal McpServer with no tools; only the initialize round trip is checked, so the tool modules are not loaded. */
export function createTestMcpServer(): McpServer {
  return new McpServer({ name: "junis-test", version: "0.0.0" });
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * fetch cannot override the Host header (forbidden header), so http.request is used directly.
 * When hostHeader is given, it is sent as Host (DNS rebinding simulation).
 */
export function rawRequest(opts: {
  port: number;
  connectHost?: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  hostHeader?: string;
}): Promise<RawResponse> {
  const connectHost = opts.connectHost ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: connectHost,
        port: opts.port,
        path: opts.path,
        method: opts.method ?? "GET",
        headers: {
          Host: opts.hostHeader ?? `${connectHost}:${opts.port}`,
          ...(opts.body !== undefined ? { "Content-Length": String(Buffer.byteLength(opts.body)) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        );
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "junis-test-client", version: "0.0.0" },
  },
});

export const MCP_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

/** Extract JSON-RPC response objects from an SSE or JSON body. */
export function parseRpcResponses(body: string, contentType: string | undefined): unknown[] {
  if ((contentType ?? "").includes("application/json")) {
    return [JSON.parse(body)];
  }
  const out: unknown[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ") && line.slice(6).trim() !== "") {
      out.push(JSON.parse(line.slice(6)));
    }
  }
  return out;
}

/** First non-loopback IPv4 interface address (null if none, and the test is skipped). */
export function firstExternalIPv4(): string | null {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (!info.internal && info.family === "IPv4") return info.address;
    }
  }
  return null;
}

/** Try a TCP connection to address:port and return only whether it succeeded. */
export function canConnect(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: "/", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}
