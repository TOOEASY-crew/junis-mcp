// src/cli/logout.ts
//
// npx junis logout: revoke the device token on the server (best effort) → stop the daemon → unregister the OS service → delete credentials.
// Deleting only the config is not enough: a running daemon would write it back on its next re-auth and silently undo the logout.
import type { RevokeResult } from "./auth.js";

export interface LogoutDeps {
  loadConfig: () => { device_key: string; token: string } | null;
  revokeDevice: (deviceKey: string, token: string) => Promise<RevokeResult>;
  stopDaemon: () => boolean;
  uninstallService: () => Promise<void>;
  clearConfig: () => void;
  log: (line: string) => void;
}

export interface LogoutOutcome {
  revoke: RevokeResult | null;
  daemonStopped: boolean;
}

export async function runLogout(deps: LogoutDeps): Promise<LogoutOutcome> {
  const config = deps.loadConfig();

  // 1) Revoke on the server; local cleanup continues even if this fails
  let revoke: RevokeResult | null = null;
  if (config) {
    try {
      revoke = await deps.revokeDevice(config.device_key, config.token);
    } catch (err) {
      revoke = { status: "failed", detail: (err as Error).message };
    }
    if (revoke.status === "revoked") {
      deps.log("✅ Device token revoked on the server");
    } else if (revoke.status === "device_only") {
      deps.log(
        "ℹ️  Device marked as revoked on the server, but this token was issued before token revocation existed and stays valid until it expires"
      );
    } else if (revoke.status === "not_supported") {
      deps.log("ℹ️  Server does not support device revoke (older server) — token left as is");
    } else {
      deps.log(`⚠️  Could not revoke device token on the server (${revoke.detail ?? "unknown error"}) — continuing locally`);
    }
  }

  // 2) Stop the daemon (via the PID file)
  const daemonStopped = deps.stopDaemon();

  // 3) Unregister launchd/systemd/schtasks (may never have been installed)
  try {
    await deps.uninstallService();
  } catch {
    /* service not installed */
  }

  // 4) Delete credentials
  deps.clearConfig();

  if (daemonStopped) deps.log("✅ Background service stopped and auto-start disabled");
  deps.log("✅ Authentication credentials cleared");

  return { revoke, daemonStopped };
}
