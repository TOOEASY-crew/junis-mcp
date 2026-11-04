// src/tools/browser-wait.ts: decides the browser_wait result (pure functions, unit-tested without a browser)
//
// Background: on pages whose ad/tracking requests never settle, loadState "networkidle" never arrives and every
// wait used to end in a 20-second Timeout error although the document was fully loaded and every following
// evaluate succeeded. That case is not an error but "condition unmet, page usable", and this module makes that
// call. Timeouts on text/textGone/url conditions stay errors (those are real conditions).

export type LoadState = "load" | "domcontentloaded" | "networkidle";
export type DocumentReadyState = "loading" | "interactive" | "complete";

/** Same as browserclaw waitFor's default timeout (normalizeTimeoutMs(…, 2e4)). */
export const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
/** Same as browserclaw normalizeTimeoutMs's floor (500ms) and ceiling (120,000ms). */
export const MIN_WAIT_TIMEOUT_MS = 500;
export const MAX_WAIT_TIMEOUT_MS = 120_000;

/** Whether this is a Playwright timeout error: "Timeout 20000ms exceeded." / "Timeout … exceeded" / "timed out" and similar. */
export function isTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /timeout\s*\d*\s*ms\s*exceeded|timed out|TimeoutError/i.test(message);
}

/** Whether document.readyState shows the requested loadState is effectively met. */
export function loadStateSatisfiedByReadyState(
  loadState: LoadState,
  readyState: DocumentReadyState | null | undefined
): boolean {
  if (readyState !== "interactive" && readyState !== "complete") return false;
  if (loadState === "domcontentloaded") return true; // interactive or later means the DOM is ready
  // "load" and "networkidle" require a complete document (networkidle may never arrive even after complete).
  return readyState === "complete";
}

export function describeWaitMet(elapsedMs: number): string {
  return `Wait condition met (${Math.max(0, Math.round(elapsedMs))}ms)`;
}

/** Message returned to the model on a timeout when the document is usable; it says plainly "do not retry, continue". */
export function describeDegradedWait(
  loadState: LoadState,
  readyState: DocumentReadyState,
  elapsedMs: number,
  timeoutMs: number
): string {
  return (
    `Wait condition met (best-effort): loadState "${loadState}" was not reached within ${timeoutMs}ms ` +
    `(waited ${Math.max(0, Math.round(elapsedMs))}ms), but the page is usable — document.readyState is "${readyState}". ` +
    `Treat the page as loaded; do not repeat this wait, continue with the next action.`
  );
}

/** The string itself if it is a valid document.readyState value, otherwise null. */
export function asReadyState(value: unknown): DocumentReadyState | null {
  return value === "loading" || value === "interactive" || value === "complete" ? value : null;
}
