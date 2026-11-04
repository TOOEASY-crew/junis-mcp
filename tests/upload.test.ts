// tests/upload.test.ts — presigned PUT target guard and required_headers filtering
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { isAllowedUploadUrl, sanitizeRequiredHeaders, uploadLargeFile } from "../src/relay/upload.js";

describe("isAllowedUploadUrl", () => {
  test("https to junis.ai, *.junis.ai and *.blob.core.windows.net is allowed by default", () => {
    for (const u of [
      "https://junis.ai/upload/x",
      "https://files.junis.ai/x?sig=1",
      "https://junisstorage.blob.core.windows.net/container/key?sv=2024&sig=abc",
    ]) {
      assert.equal(isAllowedUploadUrl(u, {}).ok, true, u);
    }
  });

  test("plain http and foreign hosts are refused; loopback keeps working for local development", () => {
    assert.equal(isAllowedUploadUrl("http://junis.ai/x", {}).ok, false);
    assert.equal(isAllowedUploadUrl("https://evil.example/x", {}).ok, false);
    assert.equal(isAllowedUploadUrl("https://blob.core.windows.net.evil.example/x", {}).ok, false);
    assert.equal(isAllowedUploadUrl("not a url", {}).ok, false);
    assert.equal(isAllowedUploadUrl("http://localhost:9000/bucket/key", {}).ok, true);
    assert.equal(isAllowedUploadUrl("http://127.0.0.1:9000/bucket/key", {}).ok, true);
  });

  test("JUNIS_UPLOAD_HOSTS extends the list (exact host or *.suffix), https still required", () => {
    const env = { JUNIS_UPLOAD_HOSTS: "s3.amazonaws.com, *.r2.cloudflarestorage.com" };
    assert.equal(isAllowedUploadUrl("https://s3.amazonaws.com/b/k", env).ok, true);
    assert.equal(isAllowedUploadUrl("https://acct.r2.cloudflarestorage.com/b/k", env).ok, true);
    assert.equal(isAllowedUploadUrl("https://other.example/b/k", env).ok, false);
    assert.equal(isAllowedUploadUrl("http://s3.amazonaws.com/b/k", env).ok, false);
  });

  test("JUNIS_ALLOW_CUSTOM_SERVER=1 trusts whatever the (custom) server hands out, over https", () => {
    assert.equal(isAllowedUploadUrl("https://minio.internal.example/b/k", { JUNIS_ALLOW_CUSTOM_SERVER: "1" }).ok, true);
    assert.equal(isAllowedUploadUrl("http://minio.internal.example/b/k", { JUNIS_ALLOW_CUSTOM_SERVER: "1" }).ok, false);
  });
});

describe("sanitizeRequiredHeaders", () => {
  test("keeps storage headers verbatim (Azure x-ms-blob-type) and drops authorization / cookie", () => {
    const out = sanitizeRequiredHeaders(
      { "x-ms-blob-type": "BlockBlob", "Content-Type": "image/png", Authorization: "Bearer leak", Cookie: "a=b", "Proxy-Authorization": "x" },
      "image/png",
    );
    assert.deepEqual(out, { "x-ms-blob-type": "BlockBlob", "Content-Type": "image/png" });
  });

  test("no required_headers → previous behaviour (Content-Type only)", () => {
    assert.deepEqual(sanitizeRequiredHeaders(undefined, "application/pdf"), { "Content-Type": "application/pdf" });
  });
});

describe("uploadLargeFile", () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  function fakeRelay(putUrl: string, headers?: Record<string, string>) {
    return {
      requestUploadUrl: async () => ({ put_url: putUrl, access_url: "https://junis.ai/a", object_key: "k", required_headers: headers }),
      requestSignedUrl: async () => ({ signed_url: "https://junis.ai/signed" }),
    } as unknown as import("../src/relay/client.js").RelayClient;
  }

  test("PUTs to an allowed URL with the sanitized headers and returns the signed URL", async () => {
    let seen: { url: string; headers: Record<string, string>; method?: string } | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(input), headers: init?.headers as Record<string, string>, method: init?.method };
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const url = await uploadLargeFile(fakeRelay("https://acct.blob.core.windows.net/c/k?sig=1", { "x-ms-blob-type": "BlockBlob", "Content-Type": "image/png", Cookie: "x" }), Buffer.from("png").toString("base64"), "a.png", "image/png");
    assert.equal(url, "https://junis.ai/signed");
    assert.ok(seen);
    assert.equal(seen!.method, "PUT");
    assert.deepEqual(seen!.headers, { "x-ms-blob-type": "BlockBlob", "Content-Type": "image/png" });
  });

  test("refuses to PUT to a disallowed host and never calls fetch", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response(null, { status: 200 }); }) as typeof fetch;
    await assert.rejects(
      () => uploadLargeFile(fakeRelay("https://exfil.example/x"), "aGk=", "a.txt", "text/plain"),
      /upload target|not allowed|JUNIS_UPLOAD_HOSTS/i,
    );
    assert.equal(called, false);
  });
});
