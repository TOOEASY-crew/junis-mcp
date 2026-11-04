// tests/auth-revoke.test.ts: revokeDevice maps 200/204 → revoked, 404/405 → not_supported, network error → failed, and never throws
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.JUNIS_API_URL = "https://api.test.invalid";
process.env.JUNIS_ALLOW_CUSTOM_SERVER = "1"; // a non-junis.ai host needs the explicit opt-in (endpoint guard)
const { revokeDevice } = await import("../src/cli/auth.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init: RequestInit | undefined };
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return impl(url, init);
  }) as typeof fetch;
  return calls;
}

describe("revokeDevice", () => {
  test("sends POST /api/auth/device/revoke with bearer + device_key body; 200 → revoked", async () => {
    const calls = stubFetch(async () => new Response("{}", { status: 200 }));
    const r = await revokeDevice("dev_key_1", "jwt_1");
    assert.equal(r.status, "revoked");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.test.invalid/api/auth/device/revoke");
    assert.equal(calls[0].init?.method, "POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer jwt_1");
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { device_key: "dev_key_1" });
  });

  test("204 → revoked", async () => {
    stubFetch(async () => new Response(null, { status: 204 }));
    assert.equal((await revokeDevice("d", "t")).status, "revoked");
  });

  test("404 / 405 → not_supported (older servers)", async () => {
    stubFetch(async () => new Response("not found", { status: 404 }));
    assert.equal((await revokeDevice("d", "t")).status, "not_supported");
    stubFetch(async () => new Response("", { status: 405 }));
    assert.equal((await revokeDevice("d", "t")).status, "not_supported");
  });

  test("network error → failed, never throws", async () => {
    stubFetch(async () => { throw new TypeError("fetch failed"); });
    const r = await revokeDevice("d", "t");
    assert.equal(r.status, "failed");
    assert.match(r.detail ?? "", /fetch failed/);
  });

  test("other statuses (401/500) → failed with the status in detail", async () => {
    stubFetch(async () => new Response("expired", { status: 401 }));
    const r1 = await revokeDevice("d", "t");
    assert.equal(r1.status, "failed");
    assert.match(r1.detail ?? "", /401/);
    stubFetch(async () => new Response("boom", { status: 500 }));
    assert.equal((await revokeDevice("d", "t")).status, "failed");
  });

  test("200 with token_revoked:false → device_only (token issued before revocation support stays valid)", async () => {
    stubFetch(async () => new Response(JSON.stringify({ revoked: true, token_revoked: false }), { status: 200 }));
    assert.equal((await revokeDevice("d", "t")).status, "device_only");
    stubFetch(async () => new Response(JSON.stringify({ revoked: true, token_revoked: true }), { status: 200 }));
    assert.equal((await revokeDevice("d", "t")).status, "revoked");
  });

  test("404 with token_revoked (device row already removed on a current server) is told apart from an older server", async () => {
    stubFetch(async () => new Response(JSON.stringify({ detail: "Device not found", token_revoked: true }), { status: 404 }));
    assert.equal((await revokeDevice("d", "t")).status, "revoked");
    stubFetch(async () => new Response(JSON.stringify({ detail: "Device not found", token_revoked: false }), { status: 404 }));
    assert.equal((await revokeDevice("d", "t")).status, "failed");
    stubFetch(async () => new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }));   // route missing (older server)
    assert.equal((await revokeDevice("d", "t")).status, "not_supported");
  });

  test("the request carries an abort signal so a silent server cannot hang logout", async () => {
    const calls = stubFetch(async () => new Response("{}", { status: 200 }));
    await revokeDevice("d", "t");
    assert.ok(calls[0].init?.signal instanceof AbortSignal);
  });
});
