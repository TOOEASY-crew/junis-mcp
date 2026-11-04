// src/relay/upload.ts
import { RelayClient } from "./client.js";
import { isLoopbackHostname, isTruthyFlag, CUSTOM_SERVER_ENV } from "../cli/endpoints.js";

const LARGE_FILE_THRESHOLD = 1 * 1024 * 1024; // 1MB (decoded bytes)

/** Hosts a presigned PUT may target by default: the Junis service and its object storage. */
export const DEFAULT_UPLOAD_HOSTS: readonly string[] = ["junis.ai", "*.junis.ai", "*.blob.core.windows.net"];

/** Headers never forwarded from `required_headers` — a server-supplied credential must not ride on the PUT. */
const DROPPED_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

type Env = Record<string, string | undefined>;

function hostMatches(host: string, rule: string): boolean {
  const r = rule.trim().toLowerCase();
  if (!r) return false;
  if (r.startsWith("*.")) return host.endsWith(r.slice(1)) && host.length > r.length - 1;
  return host === r;
}

/**
 * Is `putUrl` an acceptable upload target? https to junis.ai, *.junis.ai, *.blob.core.windows.net or any host in
 * JUNIS_UPLOAD_HOSTS (comma-separated; `host` or `*.suffix`). Loopback over http/https keeps working for local
 * development, and JUNIS_ALLOW_CUSTOM_SERVER=1 accepts any https host (a custom server hands out its own storage URLs).
 */
export function isAllowedUploadUrl(putUrl: string, env: Env = process.env): { ok: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(putUrl);
  } catch {
    return { ok: false, reason: `upload target "${putUrl}" is not a valid URL` };
  }
  const host = u.hostname.toLowerCase();
  if (isLoopbackHostname(host) && (u.protocol === "http:" || u.protocol === "https:")) {
    return { ok: true };
  }
  if (u.protocol !== "https:") {
    return { ok: false, reason: `upload target must use https (got ${u.protocol.replace(":", "://")}${host})` };
  }
  if (isTruthyFlag(env[CUSTOM_SERVER_ENV])) return { ok: true };
  const extra = (env.JUNIS_UPLOAD_HOSTS ?? "").split(",");
  for (const rule of [...DEFAULT_UPLOAD_HOSTS, ...extra]) {
    if (hostMatches(host, rule)) return { ok: true };
  }
  return {
    ok: false,
    reason: `upload target host "${host}" is not allowed (add it to JUNIS_UPLOAD_HOSTS, e.g. JUNIS_UPLOAD_HOSTS="${host}")`,
  };
}

/**
 * Headers for the presigned PUT: the server's `required_headers` as given (storage backends differ — Azure Blob
 * needs `x-ms-blob-type: BlockBlob`), minus credential headers. Without `required_headers` (older servers)
 * only Content-Type is sent, as before.
 */
export function sanitizeRequiredHeaders(required: Record<string, string> | undefined, contentType: string): Record<string, string> {
  if (!required) return { "Content-Type": contentType };
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(required)) {
    if (DROPPED_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Decode base64 data into a Buffer and PUT it to a presigned URL.
 * Returns the access URL on success.
 */
export async function uploadLargeFile(
  relay: RelayClient,
  base64Data: string,
  filename: string,
  contentType: string,
): Promise<string> {
  const buffer = Buffer.from(base64Data, "base64");

  // 1. Request a presigned PUT URL
  const { put_url, access_url, required_headers } = await relay.requestUploadUrl(
    filename,
    contentType,
    buffer.length,
  );

  // 2. HTTP PUT upload: allowed hosts and https only, no credential headers
  const allowed = isAllowedUploadUrl(put_url);
  if (!allowed.ok) {
    throw new Error(`Upload refused: ${allowed.reason}`);
  }
  const headers = sanitizeRequiredHeaders(required_headers, contentType);
  const res = await fetch(put_url, {
    method: "PUT",
    headers,
    body: buffer,
  });

  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }

  // 3. Request a signed GET URL (temporary URL the user can open)
  const { signed_url } = await relay.requestSignedUrl(access_url);
  return signed_url;
}

/**
 * Check whether a base64 string exceeds the large-file threshold.
 * Based on base64 length (decoded bytes ≈ base64 length × 0.75).
 */
export function isLargeBase64(base64: string): boolean {
  return base64.length * 0.75 > LARGE_FILE_THRESHOLD;
}

/**
 * Infer the content-type from the Buffer's magic bytes.
 */
export function detectContentType(buffer: Buffer): string {
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return "image/jpeg";
  // GIF: GIF8
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return "image/gif";
  // PDF: %PDF
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return "application/pdf";
  // WebP: RIFF????WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return "image/webp";
  // MP4: bytes[4:8] === "ftyp"
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return "video/mp4";
  // WAV: RIFF????WAVE
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45) return "audio/wav";
  // MP3 with ID3 tag
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return "audio/mpeg";
  // MP3 frame header (no ID3)
  if (buffer[0] === 0xFF && (buffer[1] === 0xFB || buffer[1] === 0xF3 || buffer[1] === 0xF2)) return "audio/mpeg";

  return "application/octet-stream";
}
