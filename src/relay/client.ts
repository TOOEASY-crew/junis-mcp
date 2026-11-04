// src/relay/client.ts
import WebSocket from "ws";
import { JunisConfig } from "../cli/config.js";
import { isLargeBase64, uploadLargeFile, detectContentType } from "./upload.js";
import { resolveEndpoints } from "../cli/endpoints.js";

// Relay URL: JUNIS_WS_URL, else derived from the JUNIS_API_URL origin (http→ws, path dropped), else wss://junis.ai.
// Every value passes the endpoint guard (junis.ai / loopback / JUNIS_ALLOW_CUSTOM_SERVER=1) — see cli/endpoints.ts.
function relayBaseUrl(): string {
  return resolveEndpoints(process.env).ws;
}

type MCPRequestHandler = (
  id: string,
  payload: unknown
) => Promise<unknown>;

// ── Reconnect robustness constants (tunable via env) ─────────────────────────────
// Invalid env values (NaN or <= 0) fall back to the defaults.
function envMs(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
// WS handshake (HTTP upgrade) limit. Without it ws waits forever, so right after waking from sleep,
// with the network half up, the socket can stay stuck in CONNECTING (there is no heartbeat before open).
const HANDSHAKE_TIMEOUT_MS = envMs("JUNIS_WS_HANDSHAKE_TIMEOUT_MS", 30_000);
// Watchdog period: detects wake from sleep and self-heals the orphan state (no connection and no reconnect scheduled).
const WATCHDOG_INTERVAL_MS = envMs("JUNIS_WS_WATCHDOG_INTERVAL_MS", 15_000);
// A watchdog tick gap larger than this means the process was asleep and has woken up.
const SLEEP_GAP_MS = 60_000;
// Missing-pong threshold. Same 90s as startHeartbeat, kept in one place so the two cannot drift apart.
const PONG_STALE_MS = 90_000;

export class RelayClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastWatchdogTick = 0;
  private destroyed = false;
  private lastPongTime = 0;
  private _currentRequestId: string | null = null;
  private _currentSessionId: string | null = null;

  get currentRequestId(): string | null { return this._currentRequestId; }
  get currentSessionId(): string | null { return this._currentSessionId; }

  // Pending map awaiting upload_url_response
  private pendingUploadRequests = new Map<string, {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
  }>();

  // Pending map awaiting signed_url_response
  private pendingSignedUrlRequests = new Map<string, {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
  }>();

  constructor(
    private config: JunisConfig,
    private onMCPRequest: MCPRequestHandler,
    private onAuthExpired?: () => Promise<void>
  ) {}

  async connect(): Promise<void> {
    if (this.destroyed) return;

    const url = `${relayBaseUrl()}/ws/devices/${this.config.device_key}`;
    console.log(`🔗 Connecting to relay server...`);

    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      // Upgrade response limit; on timeout ws emits error→close, which falls into the normal backoff reconnect
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = ws;
    this.startWatchdog();

    ws.on("open", () => {
      if (this.ws !== ws) return; // superseded by a newer connection; ignore
      console.log("✅ Connected to relay server");
      this.reconnectDelay = 1000;
      this.lastPongTime = Date.now();
      this.startHeartbeat();
    });

    ws.on("message", async (raw: Buffer) => {
      if (this.ws !== ws) return; // superseded by a newer connection; ignore
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "pong") {
          this.lastPongTime = Date.now();
          return;
        }

        if (msg.type === "upload_url_response") {
          const pending = this.pendingUploadRequests.get(msg.request_id);
          if (pending) {
            this.pendingUploadRequests.delete(msg.request_id);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg);
            }
          }
          return;
        }

        if (msg.type === "signed_url_response") {
          const pending = this.pendingSignedUrlRequests.get(msg.request_id);
          if (pending) {
            this.pendingSignedUrlRequests.delete(msg.request_id);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg);
            }
          }
          return;
        }

        if (msg.type === "mcp_request") {
          this._currentRequestId = msg.id;
          this._currentSessionId = msg.session_id || null;
          try {
            let result = await this.onMCPRequest(msg.id, msg.payload);
            this._currentRequestId = null;
            this._currentSessionId = null;
            result = await this.processLargeFiles(result);
            this.send({ type: "mcp_response", id: msg.id, payload: result });
          } catch (err) {
            this._currentRequestId = null;
            this._currentSessionId = null;
            this.send({
              type: "mcp_response",
              id: msg.id,
              payload: { error: String(err) },
            });
          }
        }
      } catch {
        // Ignore JSON parse errors
      }
    });

    ws.on("close", async (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString() || "n/a";
      console.log(`[debug] WebSocket close event: code=${code}, reason="${reasonStr}"`);
      if (this.destroyed) return;
      // Ignore if this WebSocket was superseded by a newer connection (prevents a reconnect loop)
      if (this.ws !== ws) return;

      this.stopHeartbeat();

      if (code === 4001) {
        // Token expired: run the re-auth callback instead of reconnecting
        this.destroyed = true;
        if (this.onAuthExpired) {
          await this.onAuthExpired();
        } else {
          console.error(
            "\n❌ Auth token expired. Run `npx junis --reset` to re-authenticate."
          );
          process.exit(1);
        }
        return;
      }

      if (code === 4004 || code === 4005) {
        // Device not found (4004) or agent link missing (4005): fatal
        this.destroyed = true;
        console.error(
          "\n❌ Device or team configuration is invalid. Run `npx junis --reset` to re-authenticate."
        );
        process.exit(1);
      }

      console.log(`⚠️  Disconnected (code=${code}, reason="${reasonStr}"). Reconnecting in ${this.reconnectDelay / 1000}s...`);
      // Track the timer handle so the watchdog can tell a reconnect is scheduled, and destroy can clear it
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    });

    ws.on("error", (err) => {
      console.error(`Relay error: ${err.message}${err.stack ? `\n${err.stack}` : ""}`);
    });
  }

  /** Reconnect after re-authentication completes */
  restart(): void {
    this.destroyed = false;
    this.reconnectDelay = 1000;
    this.connect();
  }

  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  sendProgress(requestId: string, line: string): void {
    this.send({
      type: "mcp_stdout",
      request_id: requestId,
      session_id: this._currentSessionId || "",
      line,
    });
  }

  /**
 * Request a presigned PUT URL from the server.
 * Sends upload_url_request over the WebSocket and waits for upload_url_response.
   */
  requestUploadUrl(filename: string, contentType: string, size: number): Promise<{
    put_url: string;
    access_url: string;
    object_key: string;
    /**
     * Headers the storage backend requires on the presigned PUT (for example `x-ms-blob-type: BlockBlob`
     * for an Azure Blob `Put Blob`, which answers 400 MissingRequiredHeader without it). Sent as given,
     * minus credential headers (see upload.ts). Older servers omit the field, so it is optional.
     */
    required_headers?: Record<string, string>;
  }> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pendingUploadRequests.delete(requestId);
        reject(new Error("Upload URL request timeout (30s)"));
      }, 30000);

      this.pendingUploadRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data as {
            put_url: string;
            access_url: string;
            object_key: string;
            required_headers?: Record<string, string>;
          });
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.send({
        type: "upload_url_request",
        request_id: requestId,
        filename,
        content_type: contentType,
        size,
      });
    });
  }

  /**
 * Request a signed GET URL from the server.
 * Sends signed_url_request over the WebSocket and waits for signed_url_response.
   */
  requestSignedUrl(accessUrl: string): Promise<{ signed_url: string }> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pendingSignedUrlRequests.delete(requestId);
        reject(new Error("Signed URL request timeout (30s)"));
      }, 30000);

      this.pendingSignedUrlRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data as { signed_url: string });
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.send({
        type: "signed_url_request",
        request_id: requestId,
        access_url: accessUrl,
      });
    });
  }

  /**
 * Detect large base64 data in an MCP response, upload it to a presigned URL and replace it with the URL.
   *
 * Targets:
   * 1. ImageContent: { type: "image", data: "<base64>", mimeType: "image/png" }
   *    → { type: "text", text: "![uploaded](https://...access_url)" }
   * 2. TextContent with large base64: { type: "text", text: "<huge base64>" }
   *    → { type: "text", text: "https://...access_url" }
   */
  private async processLargeFiles(result: unknown): Promise<unknown> {
    if (!result || typeof result !== "object") return result;

    const obj = result as Record<string, unknown>;

    // JSON-RPC response → result.result.content[]
    const inner = (obj.result as Record<string, unknown>) ?? obj;
    const content = inner.content;
    if (!Array.isArray(content)) return result;

    for (let i = 0; i < content.length; i++) {
      const item = content[i] as Record<string, unknown>;
      if (!item || typeof item !== "object") continue;

      // Case 1: ImageContent with large base64
      if (
        item.type === "image" &&
        typeof item.data === "string" &&
        isLargeBase64(item.data)
      ) {
        try {
          const mimeType = (item.mimeType as string) || "image/png";
          const ext = mimeType.split("/")[1] || "bin";
          const url = await uploadLargeFile(this, item.data, `screenshot.${ext}`, mimeType);
          content[i] = { type: "text", text: `![uploaded](${url})` };
        } catch (err) {
          console.error("Failed to upload large image:", err);
          const filename = `screenshot.${((item.mimeType as string) || "image/png").split("/")[1] || "bin"}`;
          content[i] = { type: "text", text: `[File upload failed: ${String(err)}. File name: ${filename}]` };
        }
      }

      // Case 2: __SHARE__ protocol (share_file tool)
      else if (
        item.type === "text" &&
        typeof item.text === "string" &&
        (item.text as string).startsWith("__SHARE__:")
      ) {
        try {
          const parts = (item.text as string).split(":");
          // __SHARE__:<filename>:<contentType>:<base64>
          const shareFilename = parts[1];
          const shareContentType = parts[2];
          const shareBase64 = parts.slice(3).join(":"); // base64 may contain colons? no, but join just in case
          const url = await uploadLargeFile(this, shareBase64, shareFilename, shareContentType);
          content[i] = { type: "text", text: url };
        } catch (err) {
          console.error("Failed to upload shared file:", err);
          const parts = (item.text as string).split(":");
          content[i] = { type: "text", text: `[File upload failed: ${String(err)}. File name: ${parts[1] || "unknown"}]` };
        }
      }

      // Case 3: TextContent with large base64 string (read_file binary)
      else if (
        item.type === "text" &&
        typeof item.text === "string" &&
        isLargeBase64(item.text) &&
        /^[A-Za-z0-9+/\n\r]+=*$/.test(item.text.trim())
      ) {
        try {
          const buffer = Buffer.from(item.text, "base64");
          const contentType = detectContentType(buffer);
          if (contentType === "application/octet-stream") {
            // Unrecognized binary — block base64 exposure, guide to share_file
            content[i] = { type: "text", text: "[Binary file detected. Use the share_file tool to provide a download link to the user. Do not display this message.]" };
            continue;
          }
          const ext = contentType.split("/")[1] || "bin";
          const url = await uploadLargeFile(this, item.text, `file.${ext}`, contentType);
          content[i] = { type: "text", text: url };
        } catch (err) {
          console.error("Failed to upload large text base64:", err);
          const buffer = Buffer.from(item.text as string, "base64");
          const contentType = detectContentType(buffer);
          const ext = contentType.split("/")[1] || "bin";
          item.text = `[File upload failed: ${String(err)}. File name: file.${ext}]`;
        }
      }
    }

    return result;
  }

  /**
 * Self-healing watchdog: keeps the client from going permanently silent when connection lifecycle events are lost.
   *
 * 1) Wake detection: a tick gap above SLEEP_GAP_MS means the process was suspended (e.g. macOS sleep)
 *    and has resumed. Reset the backoff, run any scheduled reconnect immediately, and force-close a half-open socket
 *    (OPEN but no pong for 90s+) with terminate so it reconnects right away.
 *    (Otherwise recovery waits for the 30s heartbeat tick plus up to 30s of backoff.)
 * 2) Orphan check: with no connection (CLOSED/CLOSING/null) and no reconnect scheduled, call connect().
 *    Last-resort safety net for a close event or timer that was lost for any reason.
   *
 * Idempotent: calling it on every connect() keeps a single interval.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.lastWatchdogTick = Date.now();
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastWatchdogTick;
      this.lastWatchdogTick = now;
      if (this.destroyed) return; // re-authenticating (4001) or shut down; restart() resumes

      if (gap > SLEEP_GAP_MS) {
        console.log(`🌙 Wake detected (${Math.round(gap / 1000)}s gap). Checking connection...`);
        this.reconnectDelay = 1000; // recover quickly after wake: reset the backoff
        if (this.reconnectTimer) {
          // Run the reconnect scheduled before sleep (up to 30s away) now instead of waiting
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
          this.connect();
        } else if (
          this.ws?.readyState === WebSocket.OPEN &&
          now - this.lastPongTime > PONG_STALE_MS
        ) {
          // Half-open socket that died during sleep: force a close event → reconnect after 1s
          this.ws.terminate();
        }
        // CONNECTING is covered by handshakeTimeout, a live OPEN socket by the heartbeat
      }

      // Orphan state: if the reconnect chain broke for any reason, restart it
      const wsDead =
        !this.ws ||
        this.ws.readyState === WebSocket.CLOSED ||
        this.ws.readyState === WebSocket.CLOSING;
      if (wsDead && !this.reconnectTimer) {
        console.log("🔁 Watchdog: no active connection and no pending reconnect. Reconnecting...");
        this.connect();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private startHeartbeat(): void {
    // Always clear the existing interval first so a connection swap (e.g. an old socket's close ignored by the guard)
    // cannot create a duplicate, which would double heartbeat sends and leak a timer.
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastPongTime > 90_000) {
        console.warn("⚠️  Heartbeat timeout (90s no pong). Reconnecting...");
        this.ws?.terminate(); // force a close event → triggers the normal reconnect logic
        return;
      }
      this.send({ type: "heartbeat" });
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stopHeartbeat();
    this.stopWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    // Clear pending upload requests
    for (const [, pending] of this.pendingUploadRequests) {
      pending.reject(new Error("Client destroyed"));
    }
    this.pendingUploadRequests.clear();
    // Clear pending signed URL requests
    for (const [, pending] of this.pendingSignedUrlRequests) {
      pending.reject(new Error("Client destroyed"));
    }
    this.pendingSignedUrlRequests.clear();
  }
}
