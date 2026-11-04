// src/cli/endpoints.ts — single place that reads JUNIS_API_URL / JUNIS_WS_URL / JUNIS_WEB_URL.
//
// The CLI sends the device token (Authorization: Bearer …) and every tool result to these hosts, so a
// value planted in the environment (shell rc, launchd plist, a copied .env) could redirect them to a
// foreign server. The guard accepts:
//   - junis.ai and *.junis.ai over https / wss only
//   - loopback hosts (localhost, 127.0.0.1, ::1) with any scheme of the right family (local development)
//   - anything else only when JUNIS_ALLOW_CUSTOM_SERVER=1 — then a red warning names the host at startup
// Everything else is refused with a clear error before any request is made.

export const DEFAULT_API_URL = "https://junis.ai";
export const DEFAULT_WS_URL = "wss://junis.ai";
export const CUSTOM_SERVER_ENV = "JUNIS_ALLOW_CUSTOM_SERVER";

export type EndpointKind = "api" | "ws" | "web";
export type Env = Record<string, string | undefined>;

export interface UrlCheck {
  ok: boolean;
  /** true when the host is neither junis.ai nor loopback and the opt-in flag allowed it */
  custom: boolean;
  host: string;
  reason?: string;
}

export interface CustomEndpoint {
  variable: string;
  host: string;
  url: string;
}

export interface ResolvedEndpoints {
  api: string;
  ws: string;
  /** web UI origin override; null = use the verification URI the server returns */
  web: string | null;
  custom: CustomEndpoint[];
}

export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointError";
  }
}

const SCHEMES: Record<EndpointKind, string[]> = {
  api: ["http:", "https:"],
  web: ["http:", "https:"],
  ws: ["ws:", "wss:"],
};
const SECURE_SCHEMES = new Set(["https:", "wss:"]);
const TRUSTED_APEX = "junis.ai";

export function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function isTrustedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === TRUSTED_APEX || h.endsWith(`.${TRUSTED_APEX}`);
}

/** Validate one server URL. Never throws. */
export function checkServerUrl(raw: string, kind: EndpointKind, env: Env): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, custom: false, host: "", reason: `"${raw}" is not a valid URL` };
  }
  const host = u.hostname;
  if (!SCHEMES[kind].includes(u.protocol)) {
    return { ok: false, custom: false, host, reason: `scheme must be ${SCHEMES[kind].map((s) => s.replace(":", "://")).join(" or ")} (got ${u.protocol.replace(":", "://")})` };
  }
  if (u.username || u.password) {
    return { ok: false, custom: false, host, reason: "credentials embedded in the URL are not allowed" };
  }
  if (!host) {
    return { ok: false, custom: false, host, reason: "URL has no host" };
  }
  if (isLoopbackHostname(host)) {
    return { ok: true, custom: false, host };
  }
  if (isTrustedHostname(host)) {
    if (!SECURE_SCHEMES.has(u.protocol)) {
      return { ok: false, custom: false, host, reason: `${host} must be reached over ${kind === "ws" ? "wss://" : "https://"} (plain ${u.protocol.replace(":", "://")} is refused)` };
    }
    return { ok: true, custom: false, host };
  }
  if (isTruthyFlag(env[CUSTOM_SERVER_ENV])) {
    return { ok: true, custom: true, host };
  }
  return {
    ok: false,
    custom: false,
    host,
    reason: `host "${host}" is not junis.ai or a local address. Set ${CUSTOM_SERVER_ENV}=1 to connect to a custom server (your device token will be sent there).`,
  };
}

function validate(variable: string, value: string, kind: EndpointKind, env: Env, custom: CustomEndpoint[]): string {
  const v = checkServerUrl(value, kind, env);
  if (!v.ok) {
    throw new EndpointError(`${variable}=${value} refused: ${v.reason}`);
  }
  if (v.custom && !custom.some((c) => c.host === v.host)) {
    custom.push({ variable, host: v.host, url: value });
  }
  return value;
}

/**
 * Resolve the three endpoints from the environment with the same derivation rules as before:
 *  - api: JUNIS_API_URL or https://junis.ai
 *  - ws : JUNIS_WS_URL, else the api origin with http→ws (path dropped)
 *  - web: JUNIS_WEB_URL, else (JUNIS_API_URL set) localhost/127.0.0.1 → <proto>//<host>:3000, other → <proto>//<host>; else null
 * Throws EndpointError for a value the guard refuses.
 */
export function resolveEndpoints(env: Env): ResolvedEndpoints {
  const custom: CustomEndpoint[] = [];
  const apiRaw = env.JUNIS_API_URL;
  const api = apiRaw ? validate("JUNIS_API_URL", apiRaw, "api", env, custom) : DEFAULT_API_URL;

  let ws: string;
  if (env.JUNIS_WS_URL) {
    ws = validate("JUNIS_WS_URL", env.JUNIS_WS_URL, "ws", env, custom);
  } else {
    try {
      const u = new URL(api);
      ws = `${u.protocol.replace("http", "ws")}//${u.host}`;
    } catch {
      ws = DEFAULT_WS_URL;
    }
  }

  let web: string | null = null;
  if (env.JUNIS_WEB_URL) {
    web = validate("JUNIS_WEB_URL", env.JUNIS_WEB_URL, "web", env, custom);
  } else if (apiRaw) {
    try {
      const u = new URL(apiRaw);
      web = u.hostname === "localhost" || u.hostname === "127.0.0.1"
        ? `${u.protocol}//${u.hostname}:3000`
        : `${u.protocol}//${u.hostname}`;
    } catch {
      web = null;
    }
  }

  return { api, ws, web, custom };
}

/** The web UI URL to print after login — JUNIS_WEB_URL, the derived one, or the public site. */
export function webUrlForDisplay(env: Env): string {
  try {
    return resolveEndpoints(env).web ?? "https://junis.ai";
  } catch {
    return "https://junis.ai";
  }
}

export interface StartupDeps {
  env: Env;
  error: (line: string) => void;
  exit: (code: number) => never;
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/**
 * Called once at CLI startup for every mode that talks to the server. A refused URL prints why and exits 1;
 * an accepted custom server prints one red warning naming the host.
 */
export function enforceEndpointsAtStartup(deps: StartupDeps): ResolvedEndpoints {
  let resolved: ResolvedEndpoints;
  try {
    resolved = resolveEndpoints(deps.env);
  } catch (err) {
    deps.error(`${RED}❌ ${(err as Error).message}${RESET}`);
    deps.error(`   Remove the variable to use https://junis.ai, point it at a *.junis.ai or localhost address, or set ${CUSTOM_SERVER_ENV}=1 to accept a custom server.`);
    return deps.exit(1);
  }
  for (const c of resolved.custom) {
    deps.error(
      `${RED}⚠️  ${CUSTOM_SERVER_ENV}=1: using a custom server "${c.host}" (${c.variable}). ` +
      `Your device token, commands, file contents and screenshots will be sent to this host.${RESET}`
    );
  }
  return resolved;
}

/** XML-escape a value for a launchd plist <string>. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const SERVICE_URL_VARS = ["JUNIS_API_URL", "JUNIS_WS_URL", "JUNIS_WEB_URL"] as const;

/**
 * Environment to persist into launchd/systemd for the daemon: only URL variables that pass the guard,
 * plus the opt-in flag when it was needed, so the background service starts exactly like the foreground run.
 */
export function serviceEndpointEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  let needsFlag = false;
  for (const name of SERVICE_URL_VARS) {
    const value = env[name];
    if (!value) continue;
    const kind: EndpointKind = name === "JUNIS_WS_URL" ? "ws" : name === "JUNIS_WEB_URL" ? "web" : "api";
    const v = checkServerUrl(value, kind, env);
    if (!v.ok) continue;
    out[name] = value;
    if (v.custom) needsFlag = true;
  }
  if (needsFlag) out[CUSTOM_SERVER_ENV] = "1";
  return out;
}
