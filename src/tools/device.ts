// src/tools/device.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import notifier from "node-notifier";
import fsp from "fs/promises";
import os from "os";
import path from "path";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** IP geolocation fallback over https (ipapi.co; the previous source only offered plain http). */
export const IP_LOCATION_URL = "https://ipapi.co/json/";

interface IpLocation {
  latitude?: number;
  longitude?: number;
  city?: string;
  country_name?: string;
  error?: boolean;
  reason?: string;
  message?: string;
}

/** Same output line as before; throws a clear error on a rate-limit / error body or missing coordinates. */
export function formatIpLocation(data: IpLocation): string {
  if (data.error) {
    throw new Error(`IP location lookup failed: ${data.reason ?? data.message ?? "unknown error"}`);
  }
  if (typeof data.latitude !== "number" || typeof data.longitude !== "number") {
    throw new Error("IP location lookup failed: no coordinates in the response");
  }
  return `Latitude: ${data.latitude}, Longitude: ${data.longitude}, City: ${data.city ?? "unknown"}, Country: ${data.country_name ?? "unknown"} (estimated via IP)`;
}

/** Private temp directory (unpredictable name) for files a tool creates and removes itself. */
async function privateTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "junis-"));
}

// The stateless HTTP server creates a new instance per request,
// so the recording PID is shared at module level
let screenRecordPid: number | null = null;

function platform(): "mac" | "win" | "linux" {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

export class DeviceTools {
  register(server: McpServer): void {
    // camera_capture
    server.tool(
      "camera_capture",
      [
        "Capture a photo from the device's camera and return it as base64 image data.",
        "",
        "Platform-specific: macOS (imagesnap), Windows (ffmpeg/dshow), Linux (fswebcam).",
        "If output_path is provided, the file is also saved to disk.",
        "",
        "PERMISSIONS (macOS): Camera permission is needed. If it fails, macOS may show a native Allow/Deny dialog — ask the user to click Allow.",
        "If still denied, use execute_command to open Camera settings:",
        "  open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'",
      ].join("\n"),
      {
        output_path: z.string().optional().describe("File path to save the captured photo. If omitted, returns image data only (temp file auto-cleaned)."),
      },
      async ({ output_path }) => {
        const p = platform();
        const isTmp = !output_path;
        const tmpDir = isTmp ? await privateTempDir() : null;
        const tmpPath = output_path ?? path.join(tmpDir!, "capture.jpg");

        const cmd = {
          mac: { bin: "imagesnap", args: [tmpPath] },
          win: { bin: "ffmpeg", args: ["-f", "dshow", "-i", "video=Default", "-frames:v", "1", tmpPath] },
          linux: { bin: "fswebcam", args: ["-r", "1280x720", tmpPath] },
        }[p];

        try {
          await execFileAsync(cmd.bin, cmd.args);
        } catch (err: unknown) {
          if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          const e = err as Error;
          const hint = p === "mac"
            ? "\n\n🔧 FIX: Camera permission may be needed. Try:\n" +
              "1. Retry — macOS may show a native Allow/Deny dialog.\n" +
              "2. If denied, run via execute_command:  open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'\n" +
              "Ask the user to toggle ON for 'imagesnap' (or their terminal app), then retry."
            : "";
          return {
            content: [{ type: "text", text: `❌ Camera capture failed.\nCause: ${e.message}${hint}` }],
            isError: true,
          };
        }
        const data = (await fsp.readFile(tmpPath)).toString("base64");
        if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore cleanup failures */ });
        return {
          content: [{ type: "image", data, mimeType: "image/jpeg" }],
        };
      }
    );

    // notification_send
    server.tool(
      "notification_send",
      "Send a native OS notification (banner/toast) to the user's desktop. Use for task completion alerts, reminders, or important status updates. The notification appears even when the terminal is not focused.",
      {
        title: z.string().describe("Notification title (displayed prominently)"),
        message: z.string().describe("Notification body text"),
      },
      async ({ title, message }) => {
        try {
          await new Promise<void>((resolve, reject) => {
            notifier.notify(
              { title, message },
              (err: Error | null) => {
                if (err) reject(err);
                else resolve();
              }
            );
          });
          return { content: [{ type: "text", text: "Notification sent" }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Notification failed: ${(err as Error).message}` }],
            isError: true,
          };
        }
      }
    );

    // clipboard_read / clipboard_write
    server.tool(
      "clipboard_read",
      "Read the current contents of the system clipboard (text). Use to access content the user has copied. Platform-specific: macOS (pbpaste), Windows (PowerShell), Linux (xclip).",
      {},
      async () => {
        const p = platform();
        const cmd = { mac: "pbpaste", win: "powershell Get-Clipboard", linux: "xclip -o" }[p];
        const { stdout } = await execAsync(cmd);
        return { content: [{ type: "text", text: stdout }] };
      }
    );

    server.tool(
      "clipboard_write",
      "Write text to the system clipboard, replacing its current contents. Use to prepare content for the user to paste elsewhere.",
      {
        text: z.string().describe("Text to copy to the clipboard"),
      },
      async ({ text }) => {
        const p = platform();
        const { spawn } = await import("child_process");

        // All platforms: pipe text via stdin to avoid shell injection
        const cmd = {
          mac: { bin: "pbcopy", args: [] as string[] },
          win: { bin: "powershell", args: ["-Command", "$input | Set-Clipboard"] },
          linux: { bin: "xclip", args: ["-selection", "clipboard"] },
        }[p];

        await new Promise<void>((resolve, reject) => {
          const proc = spawn(cmd.bin, cmd.args, { stdio: ["pipe", "ignore", "ignore"] });
          proc.on("error", reject);
          proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd.bin} exited ${code}`)));
          proc.stdin.end(text);
        });
        return { content: [{ type: "text", text: "Saved to clipboard" }] };
      }
    );

    // screen_record
    server.tool(
      "screen_record",
      [
        "Start or stop screen recording. Captures the full screen as MP4 video.",
        "",
        "Use action='start' to begin, action='stop' to end and save. Only one recording can be active at a time.",
        "Platform-specific: macOS (screencapture -v), Windows/Linux (ffmpeg).",
        "",
        "PERMISSIONS (macOS): Screen Recording permission is needed (inherited from terminal app).",
        "If denied, run via execute_command: swift -e 'import CoreGraphics; CGRequestScreenCaptureAccess()'",
        "→ macOS dialog appears. Ask user to click Allow, then retry.",
        "Fallback: open 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'",
      ].join("\n"),
      {
        action: z.enum(["start", "stop"]).describe("'start': begin recording, 'stop': end recording and save the file"),
        output_path: z.string().optional().describe("Output file path (used with 'start'). Default: a private temp directory, <tmp>/junis-XXXXXX/recording.mp4 (the path is returned)"),
      },
      async ({ action, output_path }) => {
        const p = platform();

        if (action === "start") {
          if (screenRecordPid) {
            return { content: [{ type: "text", text: "Already recording." }] };
          }
          const tmpPath = output_path ?? path.join(await privateTempDir(), "recording.mp4");
          const { spawn } = await import("child_process");

          const cmd =
            p === "mac"
              ? ["screencapture", ["-v", tmpPath]]
              : ["ffmpeg", ["-f", p === "win" ? "gdigrab" : "x11grab", "-i", p === "win" ? "desktop" : ":0.0", tmpPath]];

          // detached: true puts it in its own process group. kill tries SIGINT, but behaviour varies by OS.
          const child = spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: "ignore" });
          child.unref();
          screenRecordPid = child.pid ?? null;
          return { content: [{ type: "text", text: `Recording started. Output path: ${tmpPath} (PID: ${screenRecordPid})` }] };
        } else {
          if (!screenRecordPid) {
            return { content: [{ type: "text", text: "Not currently recording." }] };
          }
          try {
            process.kill(screenRecordPid, "SIGINT");
            // ffmpeg exits cleanly on SIGINT (finishes writing the file)
            await new Promise((r) => setTimeout(r, 1000)); // wait for the file to flush
          } catch {
            // Process already exited: ignore
          }
          screenRecordPid = null;
          return { content: [{ type: "text", text: "Recording stopped." }] };
        }
      }
    );

    // location_get
    server.tool(
      "location_get",
      [
        "Get the device's current geographic location.",
        "",
        "macOS: Uses CoreLocation (GPS-accurate) with IP-based fallback. Other platforms: IP-based geolocation (city-level accuracy only).",
        "Returns latitude, longitude, and (when available) city and country.",
      ].join("\n"),
      {},
      async () => {
        const p = platform();

        if (p === "mac") {
          try {
            // Try CoreLocationCLI (if missing, the catch falls through to the IP fallback)
            const { stdout } = await execAsync("CoreLocationCLI -once -format '%latitude,%longitude'", { timeout: 10000 });
            const [lat, lon] = stdout.trim().split(",");
            return { content: [{ type: "text", text: `Latitude: ${lat}, Longitude: ${lon}` }] };
          } catch {
            // No CoreLocationCLI or no permission: continue with the IP-based fallback
          }
        }

        // IP-based fallback (https); also reached on macOS when CoreLocationCLI fails
        try {
          const res = await fetch(IP_LOCATION_URL, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
          if (!res.ok) throw new Error(`IP location lookup failed: HTTP ${res.status}`);
          const data = (await res.json()) as IpLocation;
          return { content: [{ type: "text", text: formatIpLocation(data) }] };
        } catch (err) {
          return { content: [{ type: "text", text: `❌ ${(err as Error).message}` }], isError: true };
        }
      }
    );

    // audio_play
    server.tool(
      "audio_play",
      "Play an audio file through the device's speakers. Supports MP3, WAV, AAC, and other common formats. Playback is synchronous — the tool returns after playback completes. Platform-specific: macOS (afplay), Windows/Linux (ffplay).",
      {
        file_path: z.string().describe("Absolute path to the audio file to play"),
      },
      async ({ file_path }) => {
        const p = platform();
        const cmd = {
          mac: { bin: "afplay", args: [file_path] },
          win: { bin: "ffplay", args: ["-nodisp", "-autoexit", file_path] },
          linux: { bin: "ffplay", args: ["-nodisp", "-autoexit", file_path] },
        }[p];

        await execFileAsync(cmd.bin, cmd.args);
        return { content: [{ type: "text", text: `Playback complete: ${file_path}` }] };
      }
    );
  }
}
