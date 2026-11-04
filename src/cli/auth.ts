// src/cli/auth.ts
import open from "open";
import { createHash, randomBytes } from "crypto";
import { saveConfig } from "./config.js";
import { resolveEndpoints } from "./endpoints.js";

// Server URLs go through the endpoint guard (junis.ai / loopback / explicit opt-in) — see endpoints.ts.
// Resolved per call so a refused value surfaces as an EndpointError at the request, never at import.
function apiUrl(): string {
  return resolveEndpoints(process.env).api;
}
// JUNIS_WEB_URL: explicit → used; JUNIS_API_URL on localhost → http://localhost:3000; other host → same origin;
// unset → null (the verification_uri the server returns is used as is).
function webUrl(): string | null {
  return resolveEndpoints(process.env).web;
}

interface DeviceAuthStart {
  device_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceAuthResult {
  token: string;
  device_key: string;
  email?: string;
  agent_id?: string;
  agent_name?: string;
  organization_id?: string;  // Workspace ID auto-created on first connection
}

export async function authenticate(
  deviceName?: string,
  platform?: string,
  onBrowserOpen?: (uri: string) => void,
  onWaiting?: () => void,
  existingDeviceKey?: string,
  existingToken?: string,
  oldDeviceKey?: string,
): Promise<DeviceAuthResult> {
  // Poll secret (PKCE-style): the server only receives the hash (challenge), and only this process, which holds the verifier, can claim the token.
  // A leaked browser link (code) is therefore not enough to fetch the token. Older servers ignore this field and header, so login still works.
  const pollVerifier = randomBytes(32).toString("base64url");
  const pollChallenge = createHash("sha256").update(pollVerifier).digest("base64url");

  // 1. Request a device_code
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (existingToken) {
    headers["Authorization"] = `Bearer ${existingToken}`;
  }

  let startRes: Response;
  try {
    startRes = await fetch(`${apiUrl()}/api/auth/device/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        device_name: deviceName,
        platform,
        ...(existingDeviceKey && { device_key: existingDeviceKey }),
        ...(oldDeviceKey ? { old_device_key: oldDeviceKey } : {}),
        poll_challenge: pollChallenge,
      }),
    });
  } catch (err) {
    throw new Error(
      `Cannot connect to server. Please check your internet connection or try again later.\n(${(err as Error).message})`
    );
  }
  if (!startRes.ok) {
    const body = await startRes.text().catch(() => "");
    throw new Error(`Auth start failed: ${startRes.status} ${body}`);
  }
  const startData: DeviceAuthStart = await startRes.json();

  // Replace the origin only when JUNIS_WEB_URL is set; otherwise use the URL the server returned
  const web = webUrl();
  const verificationUri = web
    ? startData.verification_uri.replace(/^https?:\/\/[^/]+/, web)
    : startData.verification_uri;

  // Notify the caller before opening the browser
  onBrowserOpen?.(verificationUri);

  // 2. Open the browser
  try {
    await open(verificationUri);
  } catch {
    console.warn(`\n⚠️  Could not open browser automatically. Please open the following URL manually:\n\n  ${verificationUri}\n`);
  }

  // 3. Poll every `interval` seconds; must complete within `expires_in` seconds
  const deadline = Date.now() + startData.expires_in * 1000;
  const intervalMs = startData.interval * 1000;
  let waitingCallbackCalled = false;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    let pollRes: Response;
    try {
      pollRes = await fetch(
        `${apiUrl()}/api/auth/device/poll?code=${startData.device_code}`,
        { headers: { "X-Poll-Verifier": pollVerifier } }
      );
    } catch {
      // Ignore transient network errors while polling and keep going
      onWaiting?.();
      continue;
    }

    if (pollRes.status === 202) {
      if (!waitingCallbackCalled) {
        waitingCallbackCalled = true;
        onWaiting?.();
      } else {
        onWaiting?.();
      }
      continue;
    }

    if (pollRes.status === 200) {
      const result: DeviceAuthResult = await pollRes.json();
      return result;
    }

    if (pollRes.status === 410) {
      throw new Error("Authentication code has expired. Please try again.");
    }

    throw new Error(`Unexpected response: ${pollRes.status}`);
  }

  throw new Error("Authentication timed out (5 min). Please try again.");
}

export interface EnsureTeamResult {
  status: "ready" | "created" | "auth_expired" | "device_not_found";
  organization_id?: string;
  agent_id?: string;
  agent_name?: string;
  token?: string;
}

export async function ensureTeam(
  deviceKey: string,
  token: string,
): Promise<EnsureTeamResult> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/api/auth/device/ensure-team`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ device_key: deviceKey }),
    });
  } catch {
    // Network error (e.g. server down): throw so the relay caller can reconnect
    throw new Error("Network error: cannot reach server");
  }

  if (res.status === 401) {
    return { status: "auth_expired" };
  }
  if (res.status === 404) {
    return { status: "device_not_found" };
  }
  if (!res.ok) {
    throw new Error(`ensure-team failed: ${res.status}`);
  }

  const data = await res.json();
  return {
    status: data.status,  // "ready" or "created"
    organization_id: data.organization_id,
    agent_id: data.agent_id,
    agent_name: data.agent_name,
    token: data.token,
  };
}

/** device_only = the server marked the device revoked but could not add the presented token to the revocation list (legacy token without jti; valid until it expires). */
export type RevokeStatus = "revoked" | "device_only" | "not_supported" | "failed";

export interface RevokeResult {
  status: RevokeStatus;
  detail?: string;
}

/**
 * Revoke the device token on the server (logout). Never throws, so it cannot block local cleanup.
 * - 200/204 → revoked (device_only if the body has token_revoked:false: device marked, legacy token valid until expiry)
 * - 404 with token_revoked:true → revoked (device row already gone) · token_revoked:false → failed
 * - any other 404/405 → not_supported (older server without the endpoint)
 * - network error, timeout or any other status → failed
 */
const REVOKE_TIMEOUT_MS = 10_000;

export async function revokeDevice(
  deviceKey: string,
  token: string,
): Promise<RevokeResult> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/api/auth/device/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ device_key: deviceKey }),
      // Bounded so logout cannot hang for minutes on a server that accepts the connection but never answers (local cleanup runs after this)
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
  } catch (err) {
    return { status: "failed", detail: `network error: ${(err as Error).message}` };
  }

  if (res.status === 200 || res.status === 204) {
    // Newer servers answer {revoked, device_key, token_revoked}; tokens issued before revocation support (no jti) come back token_revoked:false.
    const body = res.status === 200 ? await res.json().catch(() => null) : null;
    if (body && typeof body === "object" && (body as { token_revoked?: unknown }).token_revoked === false) {
      return { status: "device_only" };
    }
    return { status: "revoked" };
  }
  if (res.status === 404 || res.status === 405) {
    // Newer servers revoke the presented token even when the device row is gone (deleted in the web app) and put
    // token_revoked in the 404 body — distinguished from an older server's 404 ({"detail":"Not Found"}).
    const body = res.status === 404 ? await res.json().catch(() => null) : null;
    const tokenRevoked = body && typeof body === "object" ? (body as { token_revoked?: unknown }).token_revoked : undefined;
    if (tokenRevoked === true) {
      return { status: "revoked", detail: "the device record was already removed on the server" };
    }
    if (tokenRevoked === false) {
      return { status: "failed", detail: "device not found on the server and this token could not be revoked" };
    }
    return { status: "not_supported", detail: `HTTP ${res.status}` };
  }
  const body = await res.text().catch(() => "");
  return { status: "failed", detail: `HTTP ${res.status}${body ? ` ${body.slice(0, 120)}` : ""}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
