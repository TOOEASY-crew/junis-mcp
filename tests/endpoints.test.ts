// tests/endpoints.test.ts — server URL guard: default https://junis.ai, *.junis.ai over https/wss, loopback with any
// scheme, anything else only with JUNIS_ALLOW_CUSTOM_SERVER=1 (red warning on stderr), otherwise a clear error.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_API_URL,
  EndpointError,
  checkServerUrl,
  resolveEndpoints,
  enforceEndpointsAtStartup,
  escapeXml,
  serviceEndpointEnv,
} from "../src/cli/endpoints.js";

type Env = Record<string, string | undefined>;

describe("checkServerUrl", () => {
  test("junis.ai and subdomains are accepted over https / wss only", () => {
    assert.equal(checkServerUrl("https://junis.ai", "api", {}).ok, true);
    assert.equal(checkServerUrl("https://example.junis.ai", "api", {}).ok, true);
    assert.equal(checkServerUrl("https://a.b.junis.ai/", "web", {}).ok, true);
    assert.equal(checkServerUrl("wss://junis.ai", "ws", {}).ok, true);
    assert.equal(checkServerUrl("http://junis.ai", "api", {}).ok, false, "plain http to junis.ai is refused");
    assert.equal(checkServerUrl("ws://junis.ai", "ws", {}).ok, false, "plain ws to junis.ai is refused");
  });

  test("look-alike hosts are not trusted", () => {
    for (const url of ["https://junis.ai.evil.com", "https://notjunis.ai", "https://junis.ai@evil.com", "https://junisxai"]) {
      const v = checkServerUrl(url, "api", {});
      assert.equal(v.ok, false, url);
    }
  });

  test("loopback hosts keep working with any scheme (local development)", () => {
    for (const url of ["http://localhost:8000", "http://127.0.0.1:8000/api", "http://[::1]:8000", "ws://localhost:8000", "https://localhost"]) {
      const v = checkServerUrl(url, url.startsWith("ws") ? "ws" : "api", {});
      assert.equal(v.ok, true, url);
      assert.equal(v.custom, false, url);
    }
  });

  test("a foreign host is refused unless JUNIS_ALLOW_CUSTOM_SERVER=1, then flagged as custom", () => {
    const refused = checkServerUrl("https://example.com", "api", {});
    assert.equal(refused.ok, false);
    assert.match(refused.reason ?? "", /JUNIS_ALLOW_CUSTOM_SERVER/);
    const allowed = checkServerUrl("https://example.com", "api", { JUNIS_ALLOW_CUSTOM_SERVER: "1" });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.custom, true);
    assert.equal(allowed.host, "example.com");
    // plain http to a foreign host also needs the opt-in
    assert.equal(checkServerUrl("http://10.0.0.5:8000", "api", {}).ok, false);
    assert.equal(checkServerUrl("http://10.0.0.5:8000", "api", { JUNIS_ALLOW_CUSTOM_SERVER: "1" }).ok, true);
    // "0", "false" and "" do not opt in
    for (const v of ["0", "false", "", "no"]) {
      assert.equal(checkServerUrl("https://example.com", "api", { JUNIS_ALLOW_CUSTOM_SERVER: v }).ok, false, `value ${JSON.stringify(v)}`);
    }
  });

  test("garbage, wrong scheme family and embedded credentials are refused", () => {
    assert.equal(checkServerUrl("not a url", "api", {}).ok, false);
    assert.equal(checkServerUrl("ftp://junis.ai", "api", {}).ok, false);
    assert.equal(checkServerUrl("https://junis.ai", "ws", {}).ok, false, "ws endpoint must be ws(s)");
    assert.equal(checkServerUrl("wss://junis.ai", "api", {}).ok, false, "api endpoint must be http(s)");
    assert.equal(checkServerUrl("https://user:pw@junis.ai", "api", {}).ok, false, "credentials in URL");
    assert.equal(checkServerUrl("https://user:pw@localhost", "api", {}).ok, false);
  });
});

describe("resolveEndpoints", () => {
  test("defaults: https://junis.ai, wss://junis.ai, no web override", () => {
    const r = resolveEndpoints({});
    assert.equal(r.api, DEFAULT_API_URL);
    assert.equal(r.ws, "wss://junis.ai");
    assert.equal(r.web, null);
    assert.deepEqual(r.custom, []);
  });

  test("ws is derived from the api origin when JUNIS_WS_URL is unset (path dropped)", () => {
    const r = resolveEndpoints({ JUNIS_API_URL: "http://localhost:8000/api" });
    assert.equal(r.api, "http://localhost:8000/api");
    assert.equal(r.ws, "ws://localhost:8000");
    assert.equal(r.web, "http://localhost:3000", "localhost api → Next.js dev web port, as before");
  });

  test("api on a junis.ai subdomain gives https web on the same host, as before", () => {
    const r = resolveEndpoints({ JUNIS_API_URL: "https://example.junis.ai" });
    assert.equal(r.ws, "wss://example.junis.ai");
    assert.equal(r.web, "https://example.junis.ai");
  });

  test("explicit JUNIS_WS_URL / JUNIS_WEB_URL are validated too", () => {
    assert.throws(() => resolveEndpoints({ JUNIS_WS_URL: "ws://relay.example.com" }), EndpointError);
    assert.throws(() => resolveEndpoints({ JUNIS_WEB_URL: "https://phish.example" }), EndpointError);
    const r = resolveEndpoints({ JUNIS_WS_URL: "ws://relay.example.com", JUNIS_ALLOW_CUSTOM_SERVER: "1" });
    assert.equal(r.ws, "ws://relay.example.com");
    assert.deepEqual(r.custom.map((c) => c.host), ["relay.example.com"]);
  });

  test("a bad JUNIS_API_URL throws an EndpointError naming the variable and the host", () => {
    assert.throws(
      () => resolveEndpoints({ JUNIS_API_URL: "https://api.example.net" }),
      (e: unknown) => e instanceof EndpointError && /JUNIS_API_URL/.test(e.message) && /api\.example\.net/.test(e.message),
    );
  });
});

describe("enforceEndpointsAtStartup", () => {
  function run(env: Env) {
    const errors: string[] = [];
    let exitCode: number | null = null;
    const r = enforceEndpointsAtStartup({
      env,
      error: (line: string) => errors.push(line),
      exit: ((code: number) => { exitCode = code; throw new Error(`exit ${code}`); }) as never,
    });
    return { r, errors, exitCode };
  }

  test("default environment: silent", () => {
    const { errors, exitCode } = run({});
    assert.deepEqual(errors, []);
    assert.equal(exitCode, null);
  });

  test("custom server opt-in prints a red warning naming the host", () => {
    const { errors, exitCode } = run({ JUNIS_API_URL: "https://selfhost.example.org", JUNIS_ALLOW_CUSTOM_SERVER: "1" });
    assert.equal(exitCode, null);
    assert.equal(errors.length >= 1, true);
    assert.match(errors.join("\n"), /\x1b\[31m/, "ANSI red");
    assert.match(errors.join("\n"), /selfhost\.example\.org/);
    assert.match(errors.join("\n"), /token/i, "says the device token will be sent there");
  });

  test("a refused URL prints the reason and exits 1", () => {
    assert.throws(() => run({ JUNIS_API_URL: "http://attacker.example" }), /exit 1/);
    const errors: string[] = [];
    try {
      enforceEndpointsAtStartup({ env: { JUNIS_API_URL: "http://attacker.example" }, error: (l: string) => errors.push(l), exit: (() => { throw new Error("x"); }) as never });
    } catch {}
    assert.match(errors.join("\n"), /attacker\.example/);
    assert.match(errors.join("\n"), /JUNIS_ALLOW_CUSTOM_SERVER=1/);
  });
});

describe("service env helpers", () => {
  test("escapeXml escapes the five XML specials", () => {
    assert.equal(escapeXml(`a<b>&"c'`), "a&lt;b&gt;&amp;&quot;c&apos;");
    assert.equal(escapeXml("plain"), "plain");
  });

  test("serviceEndpointEnv only forwards URL variables that pass the guard, plus the opt-in flag", () => {
    assert.deepEqual(serviceEndpointEnv({}), {});
    assert.deepEqual(serviceEndpointEnv({ JUNIS_API_URL: "https://example.junis.ai" }), { JUNIS_API_URL: "https://example.junis.ai" });
    assert.deepEqual(
      serviceEndpointEnv({ JUNIS_API_URL: "https://example.junis.ai", JUNIS_WS_URL: "wss://example.junis.ai", JUNIS_WEB_URL: "https://example.junis.ai" }),
      { JUNIS_API_URL: "https://example.junis.ai", JUNIS_WS_URL: "wss://example.junis.ai", JUNIS_WEB_URL: "https://example.junis.ai" },
    );
    // refused values are not persisted into launchd/systemd
    assert.deepEqual(serviceEndpointEnv({ JUNIS_API_URL: "https://evil.example" }), {});
    // with the opt-in both the URL and the flag are persisted so the daemon starts the same way
    assert.deepEqual(
      serviceEndpointEnv({ JUNIS_API_URL: "https://evil.example", JUNIS_ALLOW_CUSTOM_SERVER: "1" }),
      { JUNIS_API_URL: "https://evil.example", JUNIS_ALLOW_CUSTOM_SERVER: "1" },
    );
  });
});
