// src/server/loopback-client.ts
//
// Client that forwards MCP requests received in relay (cloud) mode to the local HTTP server in the same process.
// If the server was started with --host/--token, calls must use the same host, port and token, so startMCPServer registers the target.
import { connectHost } from "./http.js";

interface RelayTarget {
  url: string;
  token?: string;
}

let relayTarget: RelayTarget = { url: "http://127.0.0.1:3000/mcp" };

export function setRelayTarget(target: { host: string; port: number; token?: string }): void {
  relayTarget = {
    url: `http://${connectHost(target.host)}:${target.port}/mcp`,
    token: target.token || undefined,
  };
}

export function getRelayTarget(): Readonly<RelayTarget> {
  return relayTarget;
}

/**
 * Handler that processes MCP requests from the relay client.
 * Used as RelayClient.onMCPRequest in cloud mode.
 */
export async function handleMCPRequest(
  id: string,
  payload: unknown
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (relayTarget.token) {
    headers["Authorization"] = `Bearer ${relayTarget.token}`;
  }
  const res = await fetch(relayTarget.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`MCP request failed: ${res.status} ${res.statusText}`);
  }

  // 202 Accepted: notification/response only — no body
  if (res.status === 202) {
    return null;
  }

  const contentType = res.headers.get("content-type") ?? "";

  // Direct application/json response (enableJsonResponse mode)
  if (contentType.includes("application/json")) {
    return res.json();
  }

  // Parse a text/event-stream SSE response
  // MCP Streamable HTTP SSE event format:
  //   event: message          ← a valid JSON-RPC response event
  //   [id: <eventId>]
  //   data: <JSON-RPC JSON>
  //
  //   event: error            ← error event
  //   data: <JSON-RPC error JSON>
  //
  //   Priming event (when an eventStore is configured):
  //   id: <eventId>
  //   data:                   ← empty data; must be ignored
  const text = await res.text();
  const lines = text.split("\n");

  // Parse SSE events, tracking the event type together with its data
  let currentEventType: string | null = null;
  const collectedResults: unknown[] = [];
  let lastError: unknown = null;

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEventType = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      const rawData = line.slice(6).trim();

      // Ignore the empty data of a priming event
      if (rawData === "") {
        currentEventType = null;
        continue;
      }

      try {
        const parsed = JSON.parse(rawData);

        if (currentEventType === "error") {
          // error event: record as an error
          lastError = parsed;
        } else if (currentEventType === "message" || currentEventType === null) {
          // message event, or data with no event line (backward compatibility)
          collectedResults.push(parsed);
        }
      } catch {
        // Ignore JSON parse failures and continue
      }

      currentEventType = null;
    } else if (line === "") {
      // A blank line separates SSE events: reset for the next event
      currentEventType = null;
    }
  }

  // Only errors
  if (collectedResults.length === 0 && lastError !== null) {
    throw new Error(
      `MCP error event: ${JSON.stringify(lastError)}`
    );
  }

  // Multiple results: prefer the response whose id matches the payload's id
  if (collectedResults.length > 1 && payload !== null && typeof payload === "object" && "id" in payload) {
    const requestId = (payload as Record<string, unknown>).id;
    const matched = collectedResults.find(
      (r) => r !== null && typeof r === "object" && "id" in (r as object) && (r as Record<string, unknown>).id === requestId
    );
    if (matched !== undefined) {
      return matched;
    }
  }

  // Return a single result as-is; with several, return the last
  if (collectedResults.length > 0) {
    return collectedResults[collectedResults.length - 1];
  }

  return null;
}
