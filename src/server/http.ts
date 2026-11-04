// src/server/http.ts
//
// Network layer of the local MCP HTTP server: binding (loopback by default), bearer token, Host/Origin checks, routing.
// Tool registration is injected through the createMcpServer factory, so this can be tested without the tool modules (Playwright etc.).
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { connect } from "net";
import { networkInterfaces } from "os";
import { createHash, timingSafeEqual } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;

function stripBrackets(host: string): string {
  const h = host.trim();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/** Only 127.0.0.0/8, ::1 and localhost are loopback. 0.0.0.0 / :: mean "all interfaces" and are not loopback. */
export function isLoopbackHost(host: string): boolean {
  const h = stripBrackets(host).toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function isUnspecifiedHost(host: string): boolean {
  const h = stripBrackets(host);
  return h === "0.0.0.0" || h === "::";
}

/** Form used in URLs and Host headers: IPv6 in brackets. */
export function formatHostForUrl(host: string): string {
  const h = stripBrackets(host);
  return h.includes(":") ? `[${h}]` : h;
}

/** Host to use when connecting to this server from the same machine (for relay loopback calls). */
export function connectHost(host: string): string {
  const h = stripBrackets(host).toLowerCase();
  if (h === "0.0.0.0" || h === "localhost") return "127.0.0.1";
  if (h === "::") return "[::1]";
  return formatHostForUrl(h);
}

/** Host shown to the user: loopback is shown as localhost, matching the docs. */
export function displayHost(host: string): string {
  return isLoopbackHost(host) ? "localhost" : formatHostForUrl(host);
}

export function isLoopbackOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return isLoopbackHost(u.hostname);
}

/** Non-loopback interface addresses (connection hints and Host allow-list when binding 0.0.0.0/::). */
export function listInterfaceAddresses(family?: "IPv4" | "IPv6"): string[] {
  const out: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      if (family && info.family !== family) continue;
      out.push(info.address);
    }
  }
  return out;
}

/**
 * Allowed Host header values (DNS rebinding defence).
 * The three loopback forms are always allowed; --host adds its value (all interface addresses for 0.0.0.0/::).
 */
export function buildAllowedHosts(host: string, port: number): string[] {
  const set = new Set<string>([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  if (isUnspecifiedHost(host)) {
    for (const addr of listInterfaceAddresses()) set.add(`${formatHostForUrl(addr)}:${port}`.toLowerCase());
  }
  set.add(`${formatHostForUrl(host)}:${port}`.toLowerCase());
  return [...set];
}

/** Hash before comparing so differing lengths do not leak timing. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

export function extractBearerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  if (!raw) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(raw);
  return m ? m[1] : undefined;
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  extraHeaders: Record<string, string> = {}
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** Read the body of a Node.js HTTP IncomingMessage stream as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Return CORS headers only for loopback Origins; other Origins get none (the browser blocks them). */
function corsHeadersFor(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || !isLoopbackOrigin(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

function handleCors(res: ServerResponse, cors: Record<string, string>): void {
  if (Object.keys(cors).length === 0) {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(204, {
    ...cors,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, MCP-Protocol-Version, mcp-protocol-version, MCP-Session-Id",
  });
  res.end();
}

/**
 * OAuth discovery endpoints (served only in loopback mode, where no token is enforced).
 *
 * Claude Code's MCP HTTP client attempts auth on connect in this order:
 * 1. Fetch /.well-known/oauth-protected-resource/mcp
 * 2. Use the first AS in the response's authorization_servers
 *    (falls back to the server root URL as the AS if empty)
 * 3. Fetch /.well-known/oauth-authorization-server
 * 4. Without a registration_endpoint, fail with "Incompatible auth server"
 *
 * To avoid that, both endpoints respond in the expected format.
 * - oauth-protected-resource: no authorization_servers (signals that no auth is needed)
 * - oauth-authorization-server: includes registration_endpoint (signals dynamic registration support)
 *
 * Claude Code only actually triggers auth when the server returns 401.
 * Normal 200/202 responses never start the auth flow.
 *
 * These mocks are not served when a token is enforced: /oauth/token would issue a token to anyone,
 * and a client that got a 401 would loop on 401s with the fake token.
 * A client that sends the Authorization header from the start never sees a 401.
 */
function handleOAuthDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  cors: Record<string, string>
): boolean {
  const url = req.url ?? "";
  const baseUrl = `http://localhost:${port}`;

  // RFC 9728: OAuth Protected Resource Metadata
  if (
    url === "/.well-known/oauth-protected-resource" ||
    url === "/.well-known/oauth-protected-resource/mcp"
  ) {
    const metadata = {
      resource: `${baseUrl}/mcp`,
      // Omit authorization_servers entirely so the client does not look for an AS
      bearer_methods_supported: [],
    };
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(metadata));
    return true;
  }

  // RFC 8414: OAuth 2.0 Authorization Server Metadata
  // Include registration_endpoint to signal dynamic client registration support
  if (url === "/.well-known/oauth-authorization-server") {
    const metadata = {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    };
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(metadata));
    return true;
  }

  // Dynamic Client Registration endpoint (mock)
  // Return valid client info if Claude Code attempts registration
  if (url === "/oauth/register" && req.method === "POST") {
    const clientInfo = {
      client_id: `local-${Date.now()}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: [],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    res.writeHead(201, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(clientInfo));
    return true;
  }

  // Token endpoint mock (authorization_code grant)
  if (url === "/oauth/token" && req.method === "POST") {
    const tokenResponse = {
      access_token: `local-token-${Date.now()}`,
      token_type: "Bearer",
      expires_in: 86400,
    };
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(tokenResponse));
    return true;
  }

  return false;
}

interface HandlerState {
  host: string;
  port: number;
  token?: string;
  allowedHosts: Set<string>;
  createMcpServer: () => McpServer;
}

function createLocalRequestHandler(state: HandlerState) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // 1) Host header check on every path (DNS rebinding: even if an attacker's domain resolves to 127.0.0.1, the Host differs)
      const hostHeader = (req.headers.host ?? "").trim().toLowerCase();
      if (!state.allowedHosts.has(hostHeader)) {
        sendJsonRpcError(res, 403, -32000, `Invalid Host header: ${req.headers.host ?? ""}`);
        return;
      }
      // Host is case-insensitive (RFC 9110). The SDK's @hono/node-server returns 400 when the URL-parsed
      // hostname (lowercase) differs from the raw header, so normalize to the validated lowercase value.
      req.headers.host = hostHeader;

      const cors = corsHeadersFor(req);

      // 2) OPTIONS preflight (CORS): allow headers only for loopback Origins
      if (req.method === "OPTIONS") {
        handleCors(res, cors);
        return;
      }

      const tokenRequired = state.token !== undefined;

      // 3) OAuth discovery mock, only when no token is enforced (Claude Code compatibility)
      if (!tokenRequired && handleOAuthDiscovery(req, res, state.port, cors)) {
        return;
      }

      const url = req.url ?? "";

      if (url === "/mcp") {
        // 4) Block cross-origin browser calls; CLI/MCP clients do not send Origin
        const origin = req.headers.origin;
        if (origin && !isLoopbackOrigin(origin)) {
          sendJsonRpcError(res, 403, -32000, `Origin not allowed: ${origin}`);
          return;
        }
        // A server without a token rejects browser requests (those with Origin). Otherwise a web page on another localhost port
        // (e.g. XSS in a local dev server) could call the command-execution tools. Coding agents, CLIs and the relay send no Origin and are unaffected;
        // for browser use, enable --token and send that token (checked in step 5).
        if (origin && !tokenRequired) {
          sendJsonRpcError(res, 403, -32000, "Browser requests need a bearer token: start with --token <value> and send Authorization: Bearer <value>");
          return;
        }

        // 5) Bearer token (if configured), compared in constant time
        if (tokenRequired && !tokenMatches(state.token as string, extractBearerToken(req))) {
          sendJsonRpcError(res, 401, -32001, "Unauthorized: a bearer token is required (Authorization: Bearer <token>)", {
            "WWW-Authenticate": 'Bearer realm="junis"',
          });
          return;
        }

        if (req.method === "POST") {
          // MCP SDK stateless mode: a new transport + server instance per request
          // See: @modelcontextprotocol/sdk/dist/cjs/examples/server/simpleStatelessStreamableHttp.js
          const mcpServer = state.createMcpServer();
          // Host validation is handled by step 1 above (every path, case-insensitive per RFC 9110). The SDK's
          // enableDnsRebindingProtection compares the raw header case-sensitively and rejects valid requests such as
          // 'LOCALHOST:3000' with 400, so it stays off (it would add false positives, not a second check).
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless
          });

          try {
            // Parse the body up front and pass it to the transport (avoids consuming the stream twice)
            const rawBody = await readBody(req);
            const parsedBody = rawBody ? JSON.parse(rawBody) : undefined;

            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, parsedBody);

            res.on("close", () => {
              transport.close().catch(() => {});
              mcpServer.close().catch(() => {});
            });
          } catch (err) {
            console.error("MCP request error:", err);
            if (!res.headersSent) {
              sendJsonRpcError(res, 500, -32603, "Internal server error");
            }
          }
        } else if (req.method === "GET" || req.method === "DELETE") {
          // GET/DELETE /mcp: return 405, as in the SDK stateless example
          sendJsonRpcError(res, 405, -32000, "Method not allowed.");
        } else {
          res.writeHead(405);
          res.end("Method Not Allowed");
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    } catch (err) {
      console.error("HTTP server error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal server error");
      }
    }
  };
}

function boundPort(server: Server, fallback: number): number {
  const addr = server.address();
  return addr && typeof addr === "object" ? addr.port : fallback;
}

/** Whether something already answers on this port on loopback (127.0.0.1, ::1): a successful connect means in use. Never rejects. */
function loopbackPortAnswers(port: number, timeoutMs = 300): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const sock = connect({ host, port });
      const done = (answered: boolean) => {
        sock.removeAllListeners();
        sock.destroy();
        resolve(answered);
      };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
    });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then((r) => r.some(Boolean));
}

/**
 * Bind to the given host, retrying on the next port on EADDRINUSE (no retry for port 0, where the OS picks).
 * `probeLoopback`: for a loopback bind, first check whether anything answers on the port. macOS allows binding 127.0.0.1:PORT
 * (no EADDRINUSE) even while another process listens on *:PORT (0.0.0.0/::), silently hijacking the browser's localhost:PORT (e.g. a local dev server).
 */
function tryListen(server: Server, port: number, host: string, maxRetries: number, probeLoopback = false): Promise<number> {
  return new Promise((resolve, reject) => {
    let currentPort = port;
    let attempts = 0;

    const attempt = async () => {
     try {
      if (probeLoopback && currentPort !== 0 && (await loopbackPortAnswers(currentPort))) {
        if (attempts < maxRetries) {
          attempts++;
          currentPort++;
          void attempt();
        } else {
          reject(Object.assign(new Error(`port ${currentPort} is already in use`), { code: "EADDRINUSE" }));
        }
        return;
      }
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port !== 0 && attempts < maxRetries) {
          attempts++;
          currentPort++;
          void attempt();
        } else {
          reject(err);
        }
      });
      server.listen(currentPort, host, () => {
        resolve(boundPort(server, currentPort));
      });
     } catch (err) {
      reject(err as Error);   // synchronous exceptions (e.g. invalid port) go to the caller too, not to an unhandled rejection
     }
    };

    void attempt();
  });
}

/** Secondary loopback listener (best effort): null on failure. */
function listenQuiet(server: Server, port: number, host: string): Promise<Server | null> {
  return new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(port, host, () => {
      // Leave a harmless handler so later runtime errors cannot kill the process
      server.on("error", () => {});
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Binding plan: the loopback default is 127.0.0.1 plus ::1 when available,
 * so the documented http://localhost:<port>/mcp works even when the client resolves localhost to ::1.
 */
function bindPlan(host: string): { primary: string; secondary: string | null } {
  const h = stripBrackets(host).toLowerCase();
  if (h === "localhost" || h === "127.0.0.1") return { primary: "127.0.0.1", secondary: "::1" };
  if (h === "::1") return { primary: "::1", secondary: "127.0.0.1" };
  return { primary: h, secondary: null };
}

export interface LocalHttpServerOptions {
  /** Bind address. Defaults to 127.0.0.1 (+::1). Non-loopback addresses require a token. */
  host?: string;
  /** When set, POST /mcp requires Authorization: Bearer <token>. */
  token?: string;
  createMcpServer: () => McpServer;
  maxPortRetries?: number;
}

export interface BoundAddress {
  address: string;
  family: string;
  port: number;
}

export interface LocalHttpServerHandle {
  /** Normalized bind host (localhost → 127.0.0.1). */
  host: string;
  /** Actual bound port. */
  port: number;
  token?: string;
  allowedHosts: string[];
  addresses: BoundAddress[];
  close(): Promise<void>;
}

export async function listenLocalHttpServer(
  port: number,
  opts: LocalHttpServerOptions
): Promise<LocalHttpServerHandle> {
  const host = stripBrackets(opts.host ?? DEFAULT_HOST);
  const token = opts.token || undefined;
  if (!isLoopbackHost(host) && !token) {
    throw new Error(
      `A bearer token is required to bind ${host} (non-loopback). Pass --token <value> or let the CLI generate one.`
    );
  }

  const state: HandlerState = {
    host,
    port,
    token,
    allowedHosts: new Set(),
    createMcpServer: opts.createMcpServer,
  };
  const handler = createLocalRequestHandler(state);
  const plan = bindPlan(host);

  const primary = createServer(handler);
  const actualPort = await tryListen(primary, port, plan.primary, opts.maxPortRetries ?? 10, isLoopbackHost(plan.primary));
  state.port = actualPort;
  for (const h of buildAllowedHosts(host, actualPort)) state.allowedHosts.add(h);

  const servers: Server[] = [primary];
  if (plan.secondary) {
    const secondary = await listenQuiet(createServer(handler), actualPort, plan.secondary);
    if (secondary) servers.push(secondary);
  }

  const addresses: BoundAddress[] = servers.map((s) => {
    const a = s.address();
    return a && typeof a === "object"
      ? { address: a.address, family: a.family, port: a.port }
      : { address: plan.primary, family: "?", port: actualPort };
  });

  return {
    host: plan.primary === "127.0.0.1" && host.toLowerCase() === "localhost" ? "127.0.0.1" : host,
    port: actualPort,
    token,
    allowedHosts: [...state.allowedHosts],
    addresses,
    close: async () => {
      await Promise.all(servers.map(closeServer));
    },
  };
}
