// tests/local-server.test.ts: local MCP HTTP server binding, bearer token, Host/Origin checks, CORS
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import {
  listenLocalHttpServer,
  isLoopbackHost,
  isLoopbackOrigin,
  buildAllowedHosts,
  tokenMatches,
  connectHost,
  displayHost,
  type LocalHttpServerHandle,
} from "../src/server/http.js";
import { setRelayTarget, handleMCPRequest } from "../src/server/loopback-client.js";
import {
  createTestMcpServer,
  rawRequest,
  INITIALIZE_BODY,
  MCP_HEADERS,
  parseRpcResponses,
  firstExternalIPv4,
  canConnect,
} from "./helpers.js";

const handles: LocalHttpServerHandle[] = [];
async function start(opts: { host?: string; token?: string } = {}): Promise<LocalHttpServerHandle> {
  const h = await listenLocalHttpServer(0, { ...opts, createMcpServer: createTestMcpServer });
  handles.push(h);
  return h;
}
after(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe("host helpers", () => {
  test("isLoopbackHost", () => {
    for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]", "127.1.2.3"]) {
      assert.equal(isLoopbackHost(h), true, h);
    }
    for (const h of ["0.0.0.0", "::", "192.168.0.10", "10.0.0.1", "example.com", "[::]"]) {
      assert.equal(isLoopbackHost(h), false, h);
    }
  });

  test("isLoopbackOrigin", () => {
    for (const o of ["http://localhost:5173", "http://127.0.0.1:3000", "http://[::1]:3000", "https://localhost"]) {
      assert.equal(isLoopbackOrigin(o), true, o);
    }
    for (const o of ["https://evil.example", "http://192.168.0.10:3000", "null", "file://", "chrome-extension://abc", "http://localhost.evil.com"]) {
      assert.equal(isLoopbackOrigin(o), false, o);
    }
  });

  test("buildAllowedHosts always contains the three loopback forms; adds --host when given", () => {
    const base = buildAllowedHosts("127.0.0.1", 3000);
    assert.deepEqual(new Set(base), new Set(["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]));
    const lan = buildAllowedHosts("192.168.0.10", 3000);
    assert.ok(lan.includes("192.168.0.10:3000"));
    assert.ok(lan.includes("localhost:3000"));
    const v6 = buildAllowedHosts("fe80::1", 3000);
    assert.ok(v6.includes("[fe80::1]:3000"));
  });

  test("tokenMatches is exact and never throws on length mismatch", () => {
    assert.equal(tokenMatches("abc", "abc"), true);
    assert.equal(tokenMatches("abc", "abd"), false);
    assert.equal(tokenMatches("abc", "abcd"), false);
    assert.equal(tokenMatches("abc", ""), false);
    assert.equal(tokenMatches("abc", undefined), false);
  });

  test("connectHost / displayHost", () => {
    assert.equal(connectHost("0.0.0.0"), "127.0.0.1");
    assert.equal(connectHost("::"), "[::1]");
    assert.equal(connectHost("localhost"), "127.0.0.1");
    assert.equal(connectHost("192.168.0.10"), "192.168.0.10");
    assert.equal(connectHost("fe80::1"), "[fe80::1]");
    assert.equal(displayHost("127.0.0.1"), "localhost");
    assert.equal(displayHost("::1"), "localhost");
    assert.equal(displayHost("0.0.0.0"), "0.0.0.0");
  });
});

describe("default bind", () => {
  test("binds loopback only by default and resolves the real port", async () => {
    const h = await start();
    assert.equal(h.host, "127.0.0.1");
    assert.ok(h.port > 0);
    assert.ok(h.addresses.length >= 1);
    for (const a of h.addresses) {
      assert.ok(isLoopbackHost(a.address), `bound non-loopback address ${a.address}`);
      assert.equal(a.port, h.port);
    }
    assert.equal(await canConnect("127.0.0.1", h.port), true);

    const external = firstExternalIPv4();
    if (external) {
      assert.equal(await canConnect(external, h.port), false, `reachable on ${external}`);
    }
  });

  test("::1 is also served on the same port when IPv6 loopback is available", async () => {
    const h = await start();
    const hasV6 = h.addresses.some((a) => a.family === "IPv6");
    if (!hasV6) return; // pass when the environment has no IPv6 loopback
    assert.equal(await canConnect("::1", h.port), true);
  });

  test("non-loopback host without a token is refused", async () => {
    await assert.rejects(
      listenLocalHttpServer(0, { host: "0.0.0.0", createMcpServer: createTestMcpServer }),
      /token/i
    );
  });
});

describe("loopback without token (documented zero-config behaviour)", () => {
  test("POST /mcp initialize succeeds without any header", async () => {
    const h = await start();
    const res = await rawRequest({ port: h.port, path: "/mcp", method: "POST", headers: MCP_HEADERS, body: INITIALIZE_BODY });
    assert.equal(res.status, 200, res.body);
    const msgs = parseRpcResponses(res.body, res.headers["content-type"]) as Array<{ id?: number; result?: { serverInfo?: { name: string } } }>;
    const init = msgs.find((m) => m.id === 1);
    assert.ok(init?.result?.serverInfo, res.body);
    assert.equal(init.result.serverInfo.name, "junis-test");
  });

  test("OAuth discovery mocks stay available", async () => {
    const h = await start();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      const res = await rawRequest({ port: h.port, path });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers["access-control-allow-origin"], undefined, "no CORS header without Origin");
    }
    const reg = await rawRequest({ port: h.port, path: "/oauth/register", method: "POST", body: "{}" });
    assert.equal(reg.status, 201);
    const tok = await rawRequest({ port: h.port, path: "/oauth/token", method: "POST", body: "" });
    assert.equal(tok.status, 200);
  });

  test("GET /mcp is 405 and unknown paths 404 (unchanged)", async () => {
    const h = await start();
    assert.equal((await rawRequest({ port: h.port, path: "/mcp" })).status, 405);
    assert.equal((await rawRequest({ port: h.port, path: "/nope" })).status, 404);
  });
});

describe("bearer token enforcement", () => {
  const TOKEN = "s3cret-token_ABC";

  test("POST /mcp without Authorization → 401 + WWW-Authenticate + JSON body", async () => {
    const h = await start({ token: TOKEN });
    const res = await rawRequest({ port: h.port, path: "/mcp", method: "POST", headers: MCP_HEADERS, body: INITIALIZE_BODY });
    assert.equal(res.status, 401);
    assert.equal(res.headers["www-authenticate"], 'Bearer realm="junis"');
    assert.match(res.headers["content-type"] ?? "", /application\/json/);
    const body = JSON.parse(res.body);
    assert.equal(body.jsonrpc, "2.0");
    assert.ok(body.error?.message);
  });

  test("wrong token → 401; right token → 200 initialize", async () => {
    const h = await start({ token: TOKEN });
    const bad = await rawRequest({
      port: h.port, path: "/mcp", method: "POST",
      headers: { ...MCP_HEADERS, Authorization: "Bearer nope" }, body: INITIALIZE_BODY,
    });
    assert.equal(bad.status, 401);

    const ok = await rawRequest({
      port: h.port, path: "/mcp", method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` }, body: INITIALIZE_BODY,
    });
    assert.equal(ok.status, 200, ok.body);
    const msgs = parseRpcResponses(ok.body, ok.headers["content-type"]) as Array<{ id?: number; result?: unknown }>;
    assert.ok(msgs.find((m) => m.id === 1)?.result);
  });

  test("OAuth discovery / token mock endpoints are absent when a token is enforced", async () => {
    const h = await start({ token: TOKEN });
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      assert.equal((await rawRequest({ port: h.port, path })).status, 404, path);
    }
    assert.equal((await rawRequest({ port: h.port, path: "/oauth/register", method: "POST", body: "{}" })).status, 404);
    assert.equal((await rawRequest({ port: h.port, path: "/oauth/token", method: "POST", body: "" })).status, 404);
  });

  test("token is enforced on loopback too when configured", async () => {
    const h = await start({ host: "127.0.0.1", token: TOKEN });
    assert.equal(h.token, TOKEN);
    const res = await rawRequest({ port: h.port, path: "/mcp", method: "POST", headers: MCP_HEADERS, body: INITIALIZE_BODY });
    assert.equal(res.status, 401);
  });
});

describe("Host header (DNS rebinding) protection", () => {
  test("foreign Host → 403 on /mcp and on discovery endpoints", async () => {
    const h = await start();
    const mcp = await rawRequest({
      port: h.port, path: "/mcp", method: "POST", headers: MCP_HEADERS, body: INITIALIZE_BODY,
      hostHeader: "evil.example.com:80",
    });
    assert.equal(mcp.status, 403, mcp.body);
    assert.match(mcp.headers["content-type"] ?? "", /application\/json/);
    const disc = await rawRequest({ port: h.port, path: "/.well-known/oauth-protected-resource/mcp", hostHeader: "evil.example.com" });
    assert.equal(disc.status, 403);
  });

  test("localhost / 127.0.0.1 / [::1] Host forms are accepted", async () => {
    const h = await start();
    for (const hostHeader of [`localhost:${h.port}`, `127.0.0.1:${h.port}`, `[::1]:${h.port}`, `LOCALHOST:${h.port}`]) {
      const res = await rawRequest({ port: h.port, path: "/mcp", method: "POST", headers: MCP_HEADERS, body: INITIALIZE_BODY, hostHeader });
      assert.equal(res.status, 200, `${hostHeader}: ${res.body}`);
    }
  });

  test("allowedHosts are exposed on the handle (the request handler checks them on every path)", async () => {
    const h = await start();
    assert.ok(h.allowedHosts.includes(`localhost:${h.port}`));
    assert.ok(h.allowedHosts.includes(`127.0.0.1:${h.port}`));
    assert.ok(h.allowedHosts.includes(`[::1]:${h.port}`));
  });
});

describe("CORS", () => {
  test("preflight from a loopback origin is allowed and echoed; foreign origin gets no CORS headers", async () => {
    const h = await start();
    const ok = await rawRequest({ port: h.port, path: "/mcp", method: "OPTIONS", headers: { Origin: "http://localhost:5173" } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers["access-control-allow-origin"], "http://localhost:5173");
    assert.equal(ok.headers["vary"], "Origin");
    assert.match(ok.headers["access-control-allow-headers"] ?? "", /Authorization/);

    const bad = await rawRequest({ port: h.port, path: "/mcp", method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(bad.status, 204);
    assert.equal(bad.headers["access-control-allow-origin"], undefined);
    assert.equal(bad.headers["access-control-allow-methods"], undefined);

    const none = await rawRequest({ port: h.port, path: "/mcp", method: "OPTIONS" });
    assert.equal(none.status, 204);
    assert.equal(none.headers["access-control-allow-origin"], undefined);
  });

  test("discovery JSON echoes only loopback origins", async () => {
    const h = await start();
    const ok = await rawRequest({ port: h.port, path: "/.well-known/oauth-authorization-server", headers: { Origin: "http://127.0.0.1:4000" } });
    assert.equal(ok.headers["access-control-allow-origin"], "http://127.0.0.1:4000");
    const bad = await rawRequest({ port: h.port, path: "/.well-known/oauth-authorization-server", headers: { Origin: "https://evil.example" } });
    assert.equal(bad.status, 200);
    assert.equal(bad.headers["access-control-allow-origin"], undefined);
  });

  test("POST /mcp with a foreign Origin is rejected (403)", async () => {
    const h = await start();
    const res = await rawRequest({
      port: h.port, path: "/mcp", method: "POST",
      headers: { ...MCP_HEADERS, Origin: "https://evil.example" }, body: INITIALIZE_BODY,
    });
    assert.equal(res.status, 403);
  });

  test("tokenless server refuses browser requests even from a loopback Origin (another localhost page)", async () => {
    const h = await start();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:8888", `http://localhost:${h.port}`]) {
      const res = await rawRequest({
        port: h.port, path: "/mcp", method: "POST",
        headers: { ...MCP_HEADERS, Origin: origin }, body: INITIALIZE_BODY,
      });
      assert.equal(res.status, 403, origin);
      assert.match(res.body, /bearer token/);
    }
    // CLIs, coding agents and the relay (no Origin) are unaffected
    const cli = await rawRequest({ port: h.port, path: "/mcp", method: "POST", headers: MCP_HEADERS, body: INITIALIZE_BODY });
    assert.equal(cli.status, 200);
  });

  test("the cloud relay path (Node fetch, no Origin) still reaches a tokenless server", async () => {
    const h = await start();
    setRelayTarget({ host: h.host, port: h.port });
    const result = (await handleMCPRequest("req-tokenless", JSON.parse(INITIALIZE_BODY))) as { id?: number; result?: { serverInfo?: { name: string } } };
    assert.equal(result?.id, 1);
    assert.equal(result?.result?.serverInfo?.name, "junis-test");
  });

  test("with a token, a loopback browser page that sends the token still works; without it 401", async () => {
    const h = await start({ token: "browser-token" });
    const ok = await rawRequest({
      port: h.port, path: "/mcp", method: "POST",
      headers: { ...MCP_HEADERS, Origin: "http://localhost:5173", Authorization: "Bearer browser-token" }, body: INITIALIZE_BODY,
    });
    assert.equal(ok.status, 200);
    const noToken = await rawRequest({
      port: h.port, path: "/mcp", method: "POST",
      headers: { ...MCP_HEADERS, Origin: "http://localhost:5173" }, body: INITIALIZE_BODY,
    });
    assert.equal(noToken.status, 401);
  });
});

describe("relay loopback client", () => {
  test("handleMCPRequest sends the configured bearer token and uses host/port", async () => {
    const h = await start({ token: "relay-token" });
    setRelayTarget({ host: h.host, port: h.port, token: h.token });
    const result = (await handleMCPRequest("req-1", JSON.parse(INITIALIZE_BODY))) as { id?: number; result?: { serverInfo?: { name: string } } };
    assert.equal(result?.id, 1);
    assert.equal(result?.result?.serverInfo?.name, "junis-test");

    // Without the token the server returns 401, so the relay handler throws
    setRelayTarget({ host: h.host, port: h.port });
    await assert.rejects(handleMCPRequest("req-2", JSON.parse(INITIALIZE_BODY)), /401/);
  });

  test("0.0.0.0 target is connected via 127.0.0.1", () => {
    setRelayTarget({ host: "0.0.0.0", port: 3999 });
    // getRelayTarget exposes the URL
    return import("../src/server/loopback-client.js").then(({ getRelayTarget }) => {
      assert.equal(getRelayTarget().url, "http://127.0.0.1:3999/mcp");
    });
  });
});

describe("port already served by another process (macOS loopback + wildcard co-bind)", () => {
  // macOS allows binding 127.0.0.1:PORT even while another process listens on *:PORT (0.0.0.0/::). With no EADDRINUSE the port
  // is not bumped, and the browser's localhost:PORT (e.g. a local Next.js dev server) silently reaches junis. Ports that answer are skipped.
  test("skips a port another server already answers on and binds the next free one", async () => {
    const { createServer } = await import("node:http");
    const other = createServer((_req, res) => res.end("other"));
    await new Promise<void>((resolve) => other.listen(0, "0.0.0.0", () => resolve()));
    const port = (other.address() as { port: number }).port;
    try {
      const h = await listenLocalHttpServer(port, { createMcpServer: createTestMcpServer, maxPortRetries: 5 });
      handles.push(h);
      assert.notEqual(h.port, port, "must not share a port another server is answering on");
      assert.ok(h.port > port && h.port <= port + 5, String(h.port));
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});
