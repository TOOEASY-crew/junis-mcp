// src/cli/config.ts
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".junis");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/** Local MCP server binding settings (optional). The daemon takes no flags, so it reads them from here. */
export interface LocalServerSettings {
  local_host?: string;
  local_port?: number;
  local_token?: string;
  /** Token generated for relay mode's loopback server. Kept apart from local_token so `--local` is unaffected. */
  local_relay_token?: string;
}

export interface JunisConfig extends LocalServerSettings {
  device_key: string;
  token: string;
  device_name: string;
  created_at: string;
}

/** Changes to apply to the config: null deletes the key, undefined leaves it unchanged. */
export type LocalServerSettingsPatch = {
  [K in keyof LocalServerSettings]?: NonNullable<LocalServerSettings[K]> | null;
};

const CREDENTIAL_KEYS = ["device_key", "token", "device_name", "created_at"] as const;
const LOCAL_KEYS = ["local_host", "local_port", "local_token", "local_relay_token"] as const;

function readRaw(): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Restrict ~/.junis to its owner (0700) so other users on the machine cannot read the config, logs or pid file, which hold tokens.
 * mkdir does not change the mode of an existing folder (older installs created it as 0755), so chmod explicitly. Never throws
 * (effectively a no-op on Windows, which has no POSIX permissions).
 */
export function secureConfigDir(): void {
  try {
    if (fs.existsSync(CONFIG_DIR)) fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {}
}

function writeRaw(raw: Record<string, unknown>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  secureConfigDir();
  // Create new files as 0600 and narrow older 0644 files before writing, so a new token is never exposed with wider permissions, even briefly
  if (fs.existsSync(CONFIG_FILE)) fs.chmodSync(CONFIG_FILE, 0o600);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600); // owner read/write only (protects the JWT and local token)
}

function pickLocalSettings(raw: Record<string, unknown> | null): LocalServerSettings {
  const out: LocalServerSettings = {};
  if (!raw) return out;
  if (typeof raw.local_host === "string") out.local_host = raw.local_host;
  if (typeof raw.local_port === "number" && Number.isInteger(raw.local_port)) out.local_port = raw.local_port;
  if (typeof raw.local_token === "string") out.local_token = raw.local_token;
  if (typeof raw.local_relay_token === "string") out.local_relay_token = raw.local_relay_token;
  return out;
}

/** Return a config only when credentials (device_key + token) exist; a file with only local_* fields counts as unauthenticated. */
export function loadConfig(): JunisConfig | null {
  const raw = readRaw();
  if (!raw) return null;
  if (typeof raw.device_key !== "string" || typeof raw.token !== "string") return null;
  return raw as unknown as JunisConfig;
}

export function loadLocalServerSettings(): LocalServerSettings {
  return pickLocalSettings(readRaw());
}

const SECRET_KEY_PATTERN = /token|password|secret/i;

/** Copy of a config with every token/password/secret-like field replaced by "<redacted>" (for logs and error output). */
export function redactConfig<T extends Record<string, unknown>>(config: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = SECRET_KEY_PATTERN.test(key) && value !== undefined && value !== null ? "<redacted>" : value;
  }
  return out;
}

/** Save credentials. local_* fields already in the file are kept unless `config` overrides them. */
export function saveConfig(config: JunisConfig): void {
  try {
    const existingLocal = pickLocalSettings(readRaw());
    writeRaw({ ...existingLocal, ...config });
  } catch (err) {
    // Never print the token: it would land in terminal scrollback and service logs. Re-running `npx junis` issues a new one.
    console.error(`\n❌ Failed to save config file: ${(err as Error).message}`);
    console.error(`   Path: ${CONFIG_FILE}`);
    console.error(`   Fix the directory permissions and run \`npx junis\` again to log in.`);
    console.error(`   Config (secrets redacted): ${JSON.stringify(redactConfig(config as unknown as Record<string, unknown>), null, 2)}`);
  }
}

/** Update local_* fields only, whether or not credentials exist (--local users need their token remembered too). */
export function saveLocalServerSettings(patch: LocalServerSettingsPatch): void {
  const raw = readRaw() ?? {};
  for (const key of LOCAL_KEYS) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null) delete raw[key];
    else raw[key] = v;
  }
  writeRaw(raw);
}

/** Remove credentials only. local_* fields stay; the file is deleted when no keys remain. */
export function clearConfig(): void {
  const raw = readRaw();
  if (!raw) {
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    return;
  }
  for (const key of CREDENTIAL_KEYS) delete raw[key];
  const remaining: Record<string, unknown> = {};
  for (const key of LOCAL_KEYS) if (raw[key] !== undefined) remaining[key] = raw[key];
  if (Object.keys(remaining).length === 0) {
    fs.unlinkSync(CONFIG_FILE);
  } else {
    writeRaw(remaining);
  }
}
