// tests/auth-login.test.ts: device login (authenticate) sends the poll secret (PKCE-style) hashed on start and raw on poll.
// The server only issues the token to the side holding the matching secret, so a leaked browser link (code) cannot obtain it.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import childProcess from "node:child_process";

process.env.JUNIS_API_URL = "https://api.test.invalid";
process.env.JUNIS_ALLOW_CUSTOM_SERVER = "1"; // a non-junis.ai host needs the explicit opt-in (endpoint guard)
const { authenticate } = await import("../src/cli/auth.js");

const realFetch = globalThis.fetch;
const realSpawn = childProcess.spawn;
before(() => {
  // Keep the open package from launching a browser; open reads childProcess.spawn at call time
  (childProcess as { spawn: unknown }).spawn = () => ({ unref() {}, once() {} });
});
after(() => {
  globalThis.fetch = realFetch;
  (childProcess as { spawn: unknown }).spawn = realSpawn;
});

describe("authenticate", () => {
  test("sends poll_challenge = base64url(sha256(verifier)) at start and the verifier on every poll", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let polls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      if (url.endsWith("/api/auth/device/start")) {
        return new Response(JSON.stringify({ device_code: "ABCDEFGHJK", verification_uri: "https://junis.test/auth/device?code=ABCDEFGHJK", expires_in: 30, interval: 0 }), { status: 200 });
      }
      polls += 1;
      if (polls === 1) return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ token: "DEVICE-JWT", device_key: "dk-1" }), { status: 200 });
    }) as typeof fetch;

    const result = await authenticate("Test Mac", "macos");
    assert.equal(result.token, "DEVICE-JWT");

    const startBody = JSON.parse(String(calls[0].init?.body));
    assert.match(startBody.poll_challenge, /^[A-Za-z0-9_-]{43}$/, "server accepts ^[A-Za-z0-9_-]{43,128}$");
    const pollCalls = calls.filter((c) => c.url.includes("/api/auth/device/poll?code=ABCDEFGHJK"));
    assert.equal(pollCalls.length, 2);
    const verifiers = pollCalls.map((c) => (c.init?.headers as Record<string, string>)["X-Poll-Verifier"]);
    assert.ok(verifiers[0] && verifiers[0] === verifiers[1], "same verifier on every poll");
    assert.equal(createHash("sha256").update(verifiers[0]).digest("base64url"), startBody.poll_challenge);
    assert.notEqual(verifiers[0], startBody.poll_challenge, "the verifier itself never goes to start");
  });

  test("a fresh secret per login", async () => {
    const challenges: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/start")) {
        challenges.push(JSON.parse(String(init?.body)).poll_challenge);
        return new Response(JSON.stringify({ device_code: "C", verification_uri: "https://junis.test/x", expires_in: 30, interval: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ token: "t", device_key: "d" }), { status: 200 });
    }) as typeof fetch;
    await authenticate("a", "macos");
    await authenticate("a", "macos");
    assert.equal(challenges.length, 2);
    assert.notEqual(challenges[0], challenges[1]);
  });
});
