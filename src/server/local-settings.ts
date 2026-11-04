// src/server/local-settings.ts
//
// Pure function that combines --host / --port / --token flags with the local_* fields in ~/.junis/config.json
// to decide the local MCP server's binding and token. Precedence: flags > config > defaults.
// Flag values go into `persist` and are saved to the config (the daemon takes no flags, so it binds the same way from config).
import { randomBytes } from "crypto";
import { DEFAULT_HOST, DEFAULT_PORT, isLoopbackHost } from "./http.js";

export interface LocalServerSettings {
  local_host?: string;
  local_port?: number;
  local_token?: string;
}

export interface LocalServerFlags {
  host?: string;
  port?: number;
  /** string: --token <value> / false: --no-token / undefined: not given */
  token?: string | false;
}

/** Changes to apply to the config. null deletes the key. */
export type LocalServerSettingsPatch = {
  [K in keyof LocalServerSettings]?: NonNullable<LocalServerSettings[K]> | null;
};

export interface ResolvedLocalServer {
  host: string;
  port: number;
  token?: string;
  /** Whether this call generated a new token (so it is printed once) */
  generated: boolean;
  persist: LocalServerSettingsPatch;
  warnings: string[];
}

export interface ResolveOptions {
  /** Called for a non-loopback host without a token. If absent (daemon), fall back to loopback and only log a warning. */
  generateToken?: () => string;
}

const HOST_RE = /^[A-Za-z0-9.\-:%[\]]+$/;
// RFC 6750 b64token: only characters that can go into the header verbatim
const TOKEN_RE = /^[A-Za-z0-9\-._~+/]+=*$/;

export function generateLocalToken(): string {
  return randomBytes(24).toString("base64url");
}

function validHost(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && HOST_RE.test(v.trim());
}

function validPort(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
}

function validToken(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && TOKEN_RE.test(v);
}

export function resolveLocalServerSettings(
  flags: LocalServerFlags,
  saved: LocalServerSettings,
  opts: ResolveOptions = {}
): ResolvedLocalServer {
  const persist: LocalServerSettingsPatch = {};
  const warnings: string[] = [];

  // host
  let host: string;
  if (flags.host !== undefined) {
    if (!validHost(flags.host)) throw new Error(`Invalid --host value: "${flags.host}" (use an IP address or hostname, no scheme/port)`);
    host = flags.host.trim();
    persist.local_host = host;
  } else {
    host = validHost(saved.local_host) ? saved.local_host.trim() : DEFAULT_HOST;
  }

  // port
  let port: number;
  if (flags.port !== undefined) {
    if (!validPort(flags.port)) throw new Error(`Invalid --port value: ${flags.port} (1-65535)`);
    port = flags.port;
    persist.local_port = port;
  } else {
    port = validPort(saved.local_port) ? saved.local_port : DEFAULT_PORT;
  }

  // token
  let token: string | undefined;
  let generated = false;
  if (flags.token === false) {
    if (!isLoopbackHost(host)) {
      throw new Error(`--no-token cannot be used with --host ${host}: a bearer token is required on a non-loopback address`);
    }
    token = undefined;
    if (saved.local_token !== undefined) persist.local_token = null;
  } else if (flags.token !== undefined) {
    if (!validToken(flags.token)) throw new Error("Invalid --token value: must be non-empty and contain only A-Z a-z 0-9 - . _ ~ + / =");
    token = flags.token;
    persist.local_token = token;
  } else {
    token = validToken(saved.local_token) ? saved.local_token : undefined;
  }

  if (!isLoopbackHost(host) && token === undefined) {
    if (opts.generateToken) {
      token = opts.generateToken();
      generated = true;
      persist.local_token = token;
    } else {
      warnings.push(
        `A bearer token is required to bind ${host} but none is configured — falling back to ${DEFAULT_HOST} (run npx junis --host ${host} once to generate one)`
      );
      host = DEFAULT_HOST;
    }
  }

  return { host, port, token, generated, persist, warnings };
}
