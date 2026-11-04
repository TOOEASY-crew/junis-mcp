// tests/browser-wait.test.ts: browser_wait best-effort handling of loadState timeouts (pure functions + the real tool handler on a fake page)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  asReadyState,
  describeDegradedWait,
  isTimeoutError,
  loadStateSatisfiedByReadyState,
} from "../src/tools/browser-wait.js";
import { BrowserTools } from "../src/tools/browser.js";

describe("isTimeoutError", () => {
  test("recognizes Playwright's waitForLoadState timeout message", () => {
    assert.equal(isTimeoutError(new Error("page.waitForLoadState: Timeout 20000ms exceeded.")), true);
    assert.equal(isTimeoutError(new Error("locator.waitFor: Timeout 5000ms exceeded.")), true);
    assert.equal(isTimeoutError(new Error("TimeoutError: waiting failed")), true);
    assert.equal(isTimeoutError("Timeout 500ms exceeded"), true);
  });
  test("a non-timeout error stays an error", () => {
    assert.equal(isTimeoutError(new Error("Target page, context or browser has been closed")), false);
    assert.equal(isTimeoutError(new Error("Browser not started. Call browser_start first.")), false);
    assert.equal(isTimeoutError(null), false);
  });
});

describe("loadStateSatisfiedByReadyState", () => {
  test("networkidle/load are met only when the document is complete", () => {
    assert.equal(loadStateSatisfiedByReadyState("networkidle", "complete"), true);
    assert.equal(loadStateSatisfiedByReadyState("load", "complete"), true);
    assert.equal(loadStateSatisfiedByReadyState("networkidle", "interactive"), false);
    assert.equal(loadStateSatisfiedByReadyState("load", "interactive"), false);
    assert.equal(loadStateSatisfiedByReadyState("networkidle", "loading"), false);
  });
  test("domcontentloaded is met at interactive or later", () => {
    assert.equal(loadStateSatisfiedByReadyState("domcontentloaded", "interactive"), true);
    assert.equal(loadStateSatisfiedByReadyState("domcontentloaded", "complete"), true);
    assert.equal(loadStateSatisfiedByReadyState("domcontentloaded", "loading"), false);
  });
  test("an unreadable readyState (null) is not met, so the original error stands", () => {
    assert.equal(loadStateSatisfiedByReadyState("networkidle", null), false);
    assert.equal(loadStateSatisfiedByReadyState("domcontentloaded", undefined), false);
  });
  test("asReadyState accepts only the three valid values", () => {
    assert.equal(asReadyState("complete"), "complete");
    assert.equal(asReadyState("interactive"), "interactive");
    assert.equal(asReadyState("loading"), "loading");
    assert.equal(asReadyState("weird"), null);
    assert.equal(asReadyState(undefined), null);
  });
});

describe("describeDegradedWait", () => {
  test("tells the model plainly to continue so it does not retry", () => {
    const text = describeDegradedWait("networkidle", "complete", 20012, DEFAULT_WAIT_TIMEOUT_MS);
    assert.match(text, /^Wait condition met \(best-effort\)/);
    assert.match(text, /"networkidle" was not reached within 20000ms/);
    assert.match(text, /document\.readyState is "complete"/);
    assert.match(text, /do not repeat this wait/);
  });
});

// ── Real tool handler: pull the browser_wait handler out via a registration-only stub instead of McpServer and run it on a fake page ──
type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function registerAndGetWait(page: Record<string, unknown>): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  const stubServer = {
    tool: (name: string, _desc: unknown, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const tools = new BrowserTools();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools.register(stubServer as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tools as any).page = page;
  const wait = handlers.get("browser_wait");
  assert.ok(wait, "browser_wait must be registered");
  return wait;
}

const timeoutErr = () => new Error("page.waitForLoadState: Timeout 20000ms exceeded.");

describe("browser_wait handler", () => {
  test("condition met → 'Wait condition met (…ms)'", async () => {
    const calls: unknown[] = [];
    const wait = registerAndGetWait({
      waitFor: async (opts: unknown) => { calls.push(opts); },
      evaluate: async () => { throw new Error("must not be called"); },
    });
    const res = await wait({ loadState: "networkidle" });
    assert.match(res.content[0].text, /^Wait condition met \(\d+ms\)$/);
    assert.deepEqual(calls, [{ loadState: "networkidle" }]);
    assert.notEqual(res.isError, true);
  });

  test("networkidle timeout + readyState complete → best-effort success (not an error)", async () => {
    const wait = registerAndGetWait({
      waitFor: async () => { throw timeoutErr(); },
      evaluate: async (fn: string) => { assert.equal(fn, "() => document.readyState"); return "complete"; },
    });
    const res = await wait({ loadState: "networkidle" });
    assert.match(res.content[0].text, /^Wait condition met \(best-effort\)/);
    assert.match(res.content[0].text, /within 20000ms/);
    assert.notEqual(res.isError, true);
  });

  test("timeoutMs is passed through to waitFor and appears in the message", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const wait = registerAndGetWait({
      waitFor: async (opts: Record<string, unknown>) => { calls.push(opts); throw timeoutErr(); },
      evaluate: async () => "complete",
    });
    const res = await wait({ loadState: "load", timeoutMs: 5000 });
    assert.equal(calls[0].timeoutMs, 5000);
    assert.match(res.content[0].text, /within 5000ms/);
  });

  test("networkidle timeout while the document is still loading rethrows the original error", async () => {
    const wait = registerAndGetWait({
      waitFor: async () => { throw timeoutErr(); },
      evaluate: async () => "loading",
    });
    await assert.rejects(() => wait({ loadState: "networkidle" }), /Timeout 20000ms exceeded/);
  });

  test("keeps the original error when reading readyState itself fails (not swallowed)", async () => {
    const wait = registerAndGetWait({
      waitFor: async () => { throw timeoutErr(); },
      evaluate: async () => { throw new Error("Execution context was destroyed"); },
    });
    await assert.rejects(() => wait({ loadState: "load" }), /Timeout 20000ms exceeded/);
  });

  test("with a text condition, a timeout stays an error (real requirement)", async () => {
    let evaluated = false;
    const wait = registerAndGetWait({
      waitFor: async () => { throw new Error("locator.waitFor: Timeout 20000ms exceeded."); },
      evaluate: async () => { evaluated = true; return "complete"; },
    });
    await assert.rejects(() => wait({ loadState: "networkidle", text: "Top reviews" }), /Timeout 20000ms exceeded/);
    assert.equal(evaluated, false);
  });

  test("a non-timeout error (page closed) is rethrown without checking readyState", async () => {
    let evaluated = false;
    const wait = registerAndGetWait({
      waitFor: async () => { throw new Error("Target page, context or browser has been closed"); },
      evaluate: async () => { evaluated = true; return "complete"; },
    });
    await assert.rejects(() => wait({ loadState: "networkidle" }), /has been closed/);
    assert.equal(evaluated, false);
  });

  test("timeMs alone waits a fixed time and succeeds", async () => {
    const calls: unknown[] = [];
    const wait = registerAndGetWait({ waitFor: async (o: unknown) => { calls.push(o); }, evaluate: async () => "complete" });
    const res = await wait({ timeMs: 10 });
    assert.deepEqual(calls, [{ timeMs: 10 }]);
    assert.match(res.content[0].text, /^Wait condition met/);
  });
});
