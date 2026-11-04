// src/tools/desktop.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execa } from "execa";
import { z } from "zod";
import fs from "fs";

const APP_BLACKLIST = new Set(["Terminal", "iTerm2", "iTerm", "Finder"]);

let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 2;

const PERM_FIX_HINT = [
  "\n\n🔧 PERMISSION FIX:",
  "  Check: peekaboo permissions grant  (shows exact System Settings locations)",
  "  Terminal mode → grant Screen Recording + Accessibility to your terminal app.",
  "  Background mode → launch a bridge host (Peekaboo.app or Claude.app) with permissions.",
  "  Then retry.",
].join("\n");

function isPermissionError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("permission") ||
    lower.includes("accessibility") ||
    lower.includes("screen recording") ||
    lower.includes("not trusted") ||
    lower.includes("not allowed") ||
    lower.includes("denied")
  );
}

async function peekaboo(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execa("peekaboo", [...args, "--json-output"]);
    consecutiveFailures = 0;
    return JSON.parse(stdout);
  } catch (err) {
    consecutiveFailures++;
    const msg = (err as Error).message ?? "";
    const hint = isPermissionError(msg) ? PERM_FIX_HINT : "";
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      consecutiveFailures = 0;
      throw new Error(
        `peekaboo failed ${MAX_CONSECUTIVE_FAILURES}x. Auto-stopped. ${msg}${hint}`
      );
    }
    throw new Error(`${msg}${hint}`);
  }
}

function checkBlacklist(app: string | undefined): void {
  if (app && APP_BLACKLIST.has(app)) {
    throw new Error(`'${app}' is blocked for safety.`);
  }
}

function json(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Search a process's UI elements to depth 3 with osascript and return the center coordinates.
 * Skips AXTable/AXOutline/AXList at L3 (walking hundreds of rows would time out).
 * NEVER use `entire contents` — times out on complex apps (large chat or IDE windows)
 */
async function searchProcessElements(
  processName: string,
  query: string,
): Promise<string | null> {
  const safeApp = processName.replace(/[\\"]/g, "\\$&");
  const safeQuery = query.replace(/[\\"]/g, "\\$&");

  const script = `
tell application "System Events"
  tell process "${safeApp}"
    set topElems to UI elements
    repeat with elem in topElems
      try
        if (name of elem contains "${safeQuery}") or (description of elem contains "${safeQuery}") then
          set pos to position of elem
          set sz to size of elem
          set cx to (item 1 of pos) + (item 1 of sz) / 2
          set cy to (item 2 of pos) + (item 2 of sz) / 2
          return ((cx as integer) as text) & "," & ((cy as integer) as text)
        end if
      end try
    end repeat
    repeat with parent in topElems
      try
        repeat with elem in UI elements of parent
          try
            if (name of elem contains "${safeQuery}") or (description of elem contains "${safeQuery}") then
              set pos to position of elem
              set sz to size of elem
              set cx to (item 1 of pos) + (item 1 of sz) / 2
              set cy to (item 2 of pos) + (item 2 of sz) / 2
              return ((cx as integer) as text) & "," & ((cy as integer) as text)
            end if
          end try
        end repeat
      end try
    end repeat
    repeat with parent in topElems
      try
        repeat with child in UI elements of parent
          try
            set childRole to role of child
            if childRole is not "AXTable" and childRole is not "AXOutline" and childRole is not "AXList" then
              repeat with gc in UI elements of child
                try
                  if (name of gc contains "${safeQuery}") or (description of gc contains "${safeQuery}") then
                    set pos to position of gc
                    set sz to size of gc
                    set cx to (item 1 of pos) + (item 1 of sz) / 2
                    set cy to (item 2 of pos) + (item 2 of sz) / 2
                    return ((cx as integer) as text) & "," & ((cy as integer) as text)
                  end if
                end try
              end repeat
            end if
          end try
        end repeat
      end try
    end repeat
  end tell
end tell
return "NOT_FOUND"
`;

  try {
    const { stdout } = await execa("osascript", ["-e", script], { timeout: 10000 });
    const result = stdout.trim();
    if (result === "NOT_FOUND" || !result.includes(",")) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * Get an app UI element's position+size via osascript + System Events and return its center coordinates.
 * Works around peekaboo's coordinate conversion bug (Issue #63).
 * Returns null on failure, falling back to peekaboo.
 *
 * Search order: the given app (or the frontmost one) → Dock fallback.
 * The Dock is always visible but never frontmost, so it is included automatically when no app is given.
 */
async function resolveElementCoords(
  query: string,
  app?: string,
): Promise<string | null> {
  let targetApp = app;
  if (!targetApp) {
    try {
      const { stdout } = await execa("osascript", [
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ]);
      targetApp = stdout.trim();
    } catch {
      return null;
    }
  }

  // First: search the given app (or the frontmost one)
  const result = await searchProcessElements(targetApp, query);
  if (result) return result;

  // Second: Dock fallback (always on screen, never frontmost)
  // Dock items such as Trash, Launchpad and Downloads are found here
  if (targetApp !== "Dock") {
    return await searchProcessElements("Dock", query);
  }

  return null;
}

/**
 * Search UI elements by AX role and return the center coordinates of the first match.
 * Used to find elements without a name or label (input fields etc.).
 * Searches depth L1-L3 (skipping AXTable/AXOutline/AXList).
 */
async function findFirstByRole(
  role: string,
  app?: string,
): Promise<string | null> {
  let targetApp = app;
  if (!targetApp) {
    try {
      const { stdout } = await execa("osascript", [
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ]);
      targetApp = stdout.trim();
    } catch {
      return null;
    }
  }

  const safeApp = targetApp.replace(/[\\"]/g, "\\$&");
  const safeRole = role.replace(/[\\"]/g, "\\$&");

  const script = `
tell application "System Events"
  tell process "${safeApp}"
    set topElems to UI elements
    repeat with elem in topElems
      try
        if role of elem is "${safeRole}" then
          set pos to position of elem
          set sz to size of elem
          set cx to (item 1 of pos) + (item 1 of sz) / 2
          set cy to (item 2 of pos) + (item 2 of sz) / 2
          return ((cx as integer) as text) & "," & ((cy as integer) as text)
        end if
      end try
    end repeat
    repeat with parent in topElems
      try
        repeat with elem in UI elements of parent
          try
            if role of elem is "${safeRole}" then
              set pos to position of elem
              set sz to size of elem
              set cx to (item 1 of pos) + (item 1 of sz) / 2
              set cy to (item 2 of pos) + (item 2 of sz) / 2
              return ((cx as integer) as text) & "," & ((cy as integer) as text)
            end if
          end try
        end repeat
      end try
    end repeat
    repeat with parent in topElems
      try
        repeat with child in UI elements of parent
          try
            set childRole to role of child
            if childRole is not "AXTable" and childRole is not "AXOutline" and childRole is not "AXList" then
              repeat with gc in UI elements of child
                try
                  if role of gc is "${safeRole}" then
                    set pos to position of gc
                    set sz to size of gc
                    set cx to (item 1 of pos) + (item 1 of sz) / 2
                    set cy to (item 2 of pos) + (item 2 of sz) / 2
                    return ((cx as integer) as text) & "," & ((cy as integer) as text)
                  end if
                end try
              end repeat
            end if
          end try
        end repeat
      end try
    end repeat
  end tell
end tell
return "NOT_FOUND"
`;

  try {
    const { stdout } = await execa("osascript", ["-e", script], { timeout: 10000 });
    const result = stdout.trim();
    if (result === "NOT_FOUND" || !result.includes(",")) return null;
    return result;
  } catch {
    return null;
  }
}

export class DesktopTools {
  register(server: McpServer): void {
    // ═══════════════════════════════════════════════════════════
    // VISION
    // ═══════════════════════════════════════════════════════════

    server.tool(
      "desktop_see",
      [
        "Capture native UI element tree. Returns snapshot ID + elements with id/role/label/description.",
        "Useful for simple/moderate apps. May timeout on complex apps (100+ elements) — use desktop_click(query, app) which auto-resolves coordinates without needing desktop_see.",
        "IMPORTANT: Only sees native macOS UI. Web page content inside browsers is invisible — use browser_* tools.",
        "If timeout, use desktop_screenshot for visual context + desktop_click(query, app) or desktop_click(coords) to interact.",
      ].join("\n"),
      {
        app: z
          .string()
          .optional()
          .describe("App name, 'frontmost', or 'menubar'. Omit for frontmost."),
        mode: z
          .enum(["screen", "window", "frontmost"])
          .optional()
          .describe("Capture mode. Default auto-detects."),
        timeout: z
          .number()
          .optional()
          .describe("Timeout seconds (default 20). Increase for complex apps."),
        annotate: z
          .boolean()
          .optional()
          .default(false)
          .describe("Overlay element markers on screenshot"),
      },
      async ({ app, mode, timeout, annotate }) => {
        checkBlacklist(app);
        const args = ["see"];
        if (app) args.push("--app", app);
        if (mode) args.push("--mode", mode);
        if (timeout) args.push("--timeout-seconds", String(timeout));
        if (annotate) args.push("--annotate");
        const result = (await peekaboo(args)) as Record<string, unknown>;
        const data = result.data as Record<string, unknown> | undefined;
        const snapshotId = (data?.snapshot_id ??
          result.snapshotId ??
          result.snapshot_id) as string | undefined;
        const elements =
          (
            (data?.ui_elements ?? data?.elements ?? result.elements) as
              | Array<Record<string, unknown>>
              | undefined
          )?.map((e: Record<string, unknown>) => ({
            id: e.id,
            role: e.role,
            label: e.label,
            description: e.description,
          })) ?? [];
        return json({ snapshotId, elements });
      }
    );

    server.tool(
      "desktop_screenshot",
      [
        "Take a screenshot. Returns base64 image at logical resolution (matches click coordinate system 1:1).",
        "Use for visual context or to verify UI state ONLY.",
        "WARNING: NEVER estimate click coordinates from screenshot images — visual estimation causes misclicks. Use desktop_click(query, app) for auto-resolution, or execute_command + osascript for exact coords.",
        "Do not use visual coordinates from this screenshot directly. Use execute_command + osascript to verify exact element position first.",
      ].join("\n"),
      {
        app: z.string().optional().describe("Capture specific app window"),
        mode: z
          .enum(["screen", "window", "frontmost", "auto"])
          .optional()
          .default("screen")
          .describe("Capture mode"),
        windowTitle: z.string().optional().describe("Window title (partial match)"),
        windowIndex: z.number().optional().describe("Window z-order index (0=frontmost)"),
        screenIndex: z.number().optional().describe("Display index for multi-monitor"),
        format: z.enum(["png", "jpg"]).optional().default("png").describe("Output format"),
      },
      async ({ app, mode, windowTitle, windowIndex, screenIndex, format }) => {
        checkBlacklist(app);
        const args = ["image", "--mode", mode ?? "screen"];
        if (app) args.push("--app", app);
        if (windowTitle) args.push("--window-title", windowTitle);
        if (windowIndex !== undefined) args.push("--window-index", String(windowIndex));
        if (screenIndex !== undefined) args.push("--screen-index", String(screenIndex));
        if (format && format !== "png") args.push("--format", format);
        const result = (await peekaboo(args)) as Record<string, unknown>;
        const data = result.data as Record<string, unknown> | undefined;
        const files = data?.files as Array<Record<string, string>> | undefined;
        const filePath = files?.[0]?.path;
        if (filePath) {
          const imageBuffer = await fs.promises.readFile(filePath);
          const mimeType = format === "jpg" ? "image/jpeg" : "image/png";
          return {
            content: [
              { type: "image" as const, data: imageBuffer.toString("base64"), mimeType },
            ],
          };
        }
        return json(result);
      }
    );

    // ═══════════════════════════════════════════════════════════
    // INTERACTION
    // ═══════════════════════════════════════════════════════════

    server.tool(
      "desktop_click",
      [
        "Click a UI element by text label (query), AX role (role), coordinates (coords), or element ID (on).",
        "BEST: Use query with app — auto-resolves coords via accessibility API (L1-L3 depth), then falls back to full tree search for deeply nested elements. No desktop_see needed.",
        "ROLE: Use role (e.g. 'AXTextArea', 'AXTextField') to find elements without visible text labels (input fields, text areas). Searches L1-L3 depth.",
        "GOOD: Use coords 'x,y' — MUST be from osascript center calculation (position + size/2). NEVER estimate from screenshots.",
        "CAUTION: 'on' (element ID) has known offset bug — use query, role, or coords instead.",
        "If not found: try desktop_menu for menu items, desktop_hotkey for shortcuts.",
        "NOTE: Web page elements (inside browser) are invisible — use browser_* tools instead.",
      ].join("\n"),
      {
        query: z.string().optional().describe("Text/label to click (case-insensitive). Works for deeply nested elements."),
        role: z.string().optional().describe("AX role to find (e.g. 'AXTextArea', 'AXTextField', 'AXButton'). Use when element has no text label."),
        on: z.string().optional().describe("Element ID from desktop_see (e.g. 'B1', 'T2')"),
        coords: z.string().optional().describe("Screen coordinates 'x,y' (e.g. '500,300')"),
        app: z.string().optional().describe("App name"),
        snapshot: z.string().optional().describe("Snapshot ID from desktop_see"),
        doubleClick: z.boolean().optional().default(false).describe("Double-click"),
        rightClick: z.boolean().optional().default(false).describe("Right-click (context menu)"),
        waitFor: z
          .number()
          .optional()
          .describe("Max ms to wait for element to appear (default 5000)"),
      },
      async ({ query, role, on, coords, app, snapshot, doubleClick, rightClick, waitFor }) => {
        checkBlacklist(app);
        if (!query && !role && !on && !coords) throw new Error("Provide query, role, on, or coords.");
        const args = ["click"];
        if (coords) {
          args.push("--coords", coords);
        } else if (role) {
          // Search by AX role (unnamed input fields etc.)
          const resolved = await findFirstByRole(role, app);
          if (resolved) {
            args.push("--coords", resolved);
          } else {
            throw new Error(`No element with role '${role}' found in ${app ?? "frontmost app"}.`);
          }
        } else if (query) {
          // Try to resolve exact coordinates via osascript (peekaboo text search coordinates are imprecise)
          const resolved = await resolveElementCoords(query, app);
          if (resolved) {
            args.push("--coords", resolved);
          } else {
            args.push(query);
          }
        } else if (on) {
          args.push("--on", on);
        }
        if (app) args.push("--app", app);
        if (snapshot) args.push("--snapshot", snapshot);
        if (doubleClick) args.push("--double");
        if (rightClick) args.push("--right");
        if (waitFor) args.push("--wait-for", String(waitFor));
        return json(await peekaboo(args));
      }
    );

    server.tool(
      "desktop_type",
      [
        "Type text via keyboard. Supports \\n (return), \\t (tab) escape sequences.",
        "IMPORTANT: Focus the target field first — use desktop_click(query, app) for labeled fields, or desktop_click(role:'AXTextArea', app) for unlabeled input areas.",
        "For Korean/Japanese/Chinese/emoji, use desktop_paste instead (keyboard sim is ASCII only).",
        "Use clear=true to replace existing text (Cmd+A → Delete before typing).",
      ].join("\n"),
      {
        text: z
          .string()
          .describe("Text to type. Supports \\n (return), \\t (tab) escape sequences."),
        app: z.string().optional().describe("App name"),
        pressReturn: z.boolean().optional().default(false).describe("Press Return after typing"),
        clear: z
          .boolean()
          .optional()
          .default(false)
          .describe("Clear field first (Cmd+A, Delete)"),
        tab: z.number().optional().describe("Press Tab N times after typing"),
      },
      async ({ text, app, pressReturn, clear, tab }) => {
        checkBlacklist(app);
        const args = ["type", text];
        if (app) args.push("--app", app);
        if (clear) args.push("--clear");
        if (pressReturn) args.push("--return");
        if (tab) args.push("--tab", String(tab));
        return json(await peekaboo(args));
      }
    );

    server.tool(
      "desktop_paste",
      [
        "Paste via clipboard (Cmd+V). Atomic: saves clipboard → sets content → pastes → restores.",
        "IMPORTANT: Focus the target field first — use desktop_click(query, app) for labeled fields, or desktop_click(role:'AXTextArea', app) for unlabeled input areas.",
        "Supports all Unicode (Korean, Japanese, Chinese, emoji). Use instead of desktop_type for non-ASCII.",
        "Can also paste file contents via filePath.",
      ].join("\n"),
      {
        text: z.string().optional().describe("Text to paste"),
        filePath: z.string().optional().describe("File path to paste contents of"),
        app: z.string().optional().describe("App name"),
      },
      async ({ text, filePath, app }) => {
        checkBlacklist(app);
        if (!text && !filePath) throw new Error("Provide text or filePath.");
        const args = ["paste"];
        if (text) args.push("--text", text);
        if (filePath) args.push("--file-path", filePath);
        if (app) args.push("--app", app);
        return json(await peekaboo(args));
      }
    );

    server.tool(
      "desktop_hotkey",
      [
        "Press a keyboard shortcut (keys held simultaneously).",
        "Modifiers: cmd, shift, alt, ctrl, fn. Keys: a-z, 0-9, space, return, tab, escape, delete, arrows, f1-f12.",
        "For single special keys (Tab, Return), prefer desktop_press.",
      ].join("\n"),
      {
        keys: z
          .string()
          .describe("Comma-separated combo (e.g. 'cmd,c', 'cmd,shift,t', 'cmd,v')"),
        app: z.string().optional().describe("App name"),
        holdDuration: z.number().optional().describe("Hold duration in ms (default 50)"),
      },
      async ({ keys, app, holdDuration }) => {
        checkBlacklist(app);
        const args = ["hotkey", keys];
        if (app) args.push("--app", app);
        if (holdDuration) args.push("--hold-duration", String(holdDuration));
        return json(await peekaboo(args));
      }
    );

    server.tool(
      "desktop_press",
      [
        "Press special keys one or more times. Use for Tab navigation, Enter confirm, Escape dismiss, arrow keys.",
        "For shortcuts with modifiers (Cmd+C), use desktop_hotkey instead.",
      ].join("\n"),
      {
        keys: z
          .string()
          .describe(
            "Space-separated keys: return, tab, escape, delete, space, up, down, left, right, f1-f12, home, end, pageup, pagedown"
          ),
        count: z.number().optional().default(1).describe("Repeat count"),
        delay: z.number().optional().describe("Delay between presses in ms (default 100)"),
        app: z.string().optional().describe("App name"),
      },
      async ({ keys, count, delay, app }) => {
        checkBlacklist(app);
        const args = ["press", ...keys.split(/[\s,]+/).filter(Boolean)];
        if (count && count > 1) args.push("--count", String(count));
        if (delay) args.push("--delay", String(delay));
        if (app) args.push("--app", app);
        return json(await peekaboo(args));
      }
    );

    server.tool(
      "desktop_scroll",
      "Scroll in a direction. Can target a specific element or scroll at current mouse position.",
      {
        direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
        amount: z.number().optional().default(3).describe("Scroll ticks (default 3)"),
        on: z.string().optional().describe("Element ID to scroll within (from desktop_see)"),
        app: z.string().optional().describe("App name"),
        smooth: z.boolean().optional().default(false).describe("Smooth scrolling"),
      },
      async ({ direction, amount, on, app, smooth }) => {
        checkBlacklist(app);
        const args = ["scroll", "--direction", direction, "--amount", String(amount)];
        if (on) args.push("--on", on);
        if (app) args.push("--app", app);
        if (smooth) args.push("--smooth");
        return json(await peekaboo(args));
      }
    );

    server.tool(
      "desktop_move",
      [
        "Move mouse cursor without clicking. Use before scroll or to hover.",
        "Before using coords, always query exact position via execute_command + osascript. Calculate center = position + size/2. Never estimate from screenshots.",
      ].join("\n"),
      {
        coords: z.string().optional().describe("Screen coordinates 'x,y'"),
        to: z.string().optional().describe("Element text/label to move to"),
        id: z.string().optional().describe("Element ID from desktop_see"),
        app: z.string().optional().describe("App name"),
        snapshot: z.string().optional().describe("Snapshot ID from desktop_see"),
        smooth: z.boolean().optional().default(false).describe("Animate cursor movement"),
      },
      async ({ coords, to, id, app, snapshot, smooth }) => {
        checkBlacklist(app);
        if (!coords && !to && !id) throw new Error("Provide coords, to, or id.");
        const args = ["move"];
        if (coords) {
          args.push(coords);
        } else if (to) {
          const resolved = await resolveElementCoords(to, app);
          if (resolved) {
            args.push(resolved);
          } else {
            args.push("--to", to);
          }
        } else if (id) {
          args.push("--id", id);
        }
        if (app) args.push("--app", app);
        if (snapshot) args.push("--snapshot", snapshot);
        if (smooth) args.push("--smooth");
        return json(await peekaboo(args));
      }
    );

    server.tool(
      "desktop_drag",
      [
        "Drag and drop between elements or coordinates. Supports cross-app drag (e.g. file to Trash).",
        "Prefer fromCoords/toCoords for accuracy. Element IDs (from/to) have known offset bug.",
        "Before using fromCoords/toCoords, always query exact position via execute_command + osascript. Calculate center = position + size/2. Never estimate from screenshots.",
      ].join("\n"),
      {
        from: z.string().optional().describe("Source element ID from desktop_see"),
        fromCoords: z.string().optional().describe("Source coordinates 'x,y'"),
        to: z.string().optional().describe("Destination element ID"),
        toCoords: z.string().optional().describe("Destination coordinates 'x,y'"),
        toApp: z
          .string()
          .optional()
          .describe("Destination app for cross-app drag (e.g. 'Trash')"),
        app: z.string().optional().describe("Source app name"),
        duration: z.number().optional().describe("Drag duration in ms (default 500)"),
        modifiers: z
          .string()
          .optional()
          .describe("Modifier keys during drag: 'cmd', 'shift', 'alt', 'ctrl'"),
      },
      async ({ from, fromCoords, to, toCoords, toApp, app, duration, modifiers }) => {
        checkBlacklist(app);
        if (!from && !fromCoords) throw new Error("Provide from or fromCoords.");
        if (!to && !toCoords && !toApp) throw new Error("Provide to, toCoords, or toApp.");
        const args = ["drag"];
        if (from) args.push("--from", from);
        if (fromCoords) args.push("--from-coords", fromCoords);
        if (to) args.push("--to", to);
        if (toCoords) args.push("--to-coords", toCoords);
        if (toApp) args.push("--to-app", toApp);
        if (app) args.push("--app", app);
        if (duration) args.push("--duration", String(duration));
        if (modifiers) args.push("--modifiers", modifiers);
        return json(await peekaboo(args));
      }
    );

    // ═══════════════════════════════════════════════════════════
    // APP & WINDOW MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    server.tool(
      "desktop_open_app",
      [
        "Launch or activate a macOS app. Already running apps are brought to front. Terminal/iTerm/Finder blocked.",
        "After launch, wait briefly then use desktop_click(query, app) to interact. desktop_see may timeout on complex apps — use desktop_screenshot as visual fallback.",
      ].join("\n"),
      {
        app: z.string().describe("App name (e.g. 'Safari', 'Messages', 'Slack')"),
      },
      async ({ app }) => {
        checkBlacklist(app);
        return json(await peekaboo(["app", "launch", app, "--wait-until-ready"]));
      }
    );

    server.tool(
      "desktop_app_quit",
      "Quit a macOS app. Use force=true for unresponsive apps. Terminal/iTerm/Finder blocked.",
      {
        app: z.string().describe("App name to quit"),
        force: z.boolean().optional().default(false).describe("Force quit (kill process)"),
      },
      async ({ app, force }) => {
        checkBlacklist(app);
        const args = ["app", "quit", "--app", app];
        if (force) args.push("--force");
        return json(await peekaboo(args));
      }
    );

    server.tool(
      "desktop_window",
      [
        "Manage app windows: close, minimize, maximize, resize, move, set-bounds, focus.",
        "Use set-bounds to move+resize in one step (requires x, y, width, height).",
        "Use desktop_list_windows to find window titles/indices first.",
      ].join("\n"),
      {
        action: z
          .enum(["close", "minimize", "maximize", "resize", "move", "set-bounds", "focus"])
          .describe("Window action"),
        app: z.string().optional().describe("App name"),
        windowTitle: z.string().optional().describe("Window title"),
        windowIndex: z.number().optional().describe("Window index (0=frontmost)"),
        x: z.number().optional().describe("X position (move, set-bounds)"),
        y: z.number().optional().describe("Y position (move, set-bounds)"),
        width: z.number().optional().describe("Width (resize, set-bounds)"),
        height: z.number().optional().describe("Height (resize, set-bounds)"),
      },
      async ({ action, app, windowTitle, windowIndex, x, y, width, height }) => {
        checkBlacklist(app);
        const args = ["window", action];
        if (app) args.push("--app", app);
        if (windowTitle) args.push("--window-title", windowTitle);
        if (windowIndex !== undefined) args.push("--window-index", String(windowIndex));
        if (action === "move" || action === "set-bounds") {
          if (x !== undefined) args.push("-x", String(x));
          if (y !== undefined) args.push("-y", String(y));
        }
        if (action === "resize" || action === "set-bounds") {
          if (width !== undefined) args.push("--width", String(width));
          if (height !== undefined) args.push("--height", String(height));
        }
        return json(await peekaboo(args));
      }
    );

    server.tool(
      "desktop_dialog",
      [
        "Handle system dialogs/alerts: click buttons, enter text, handle file dialogs, dismiss.",
        "Capture dialog with desktop_see first to identify controls. Use action='list' to inspect elements.",
        "If dialog helpers fail, fall back to desktop_click for precise button targeting.",
      ].join("\n"),
      {
        action: z
          .enum(["list", "click", "input", "file", "dismiss"])
          .describe("Dialog action"),
        app: z.string().optional().describe("App showing the dialog"),
        button: z.string().optional().describe("Button text to click (action='click')"),
        text: z.string().optional().describe("Text to enter (action='input')"),
        path: z.string().optional().describe("Directory path (action='file')"),
        name: z.string().optional().describe("Filename for save dialogs (action='file')"),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe("Force dismiss with Escape (action='dismiss')"),
      },
      async ({ action, app, button, text, path, name, force }) => {
        checkBlacklist(app);
        const args = ["dialog", action];
        if (app) args.push("--app", app);
        if (button) args.push("--button", button);
        if (text) args.push("--text", text);
        if (path) args.push("--path", path);
        if (name) args.push("--name", name);
        if (force) args.push("--force");
        return json(await peekaboo(args));
      }
    );

    // ═══════════════════════════════════════════════════════════
    // CLIPBOARD & MENU
    // ═══════════════════════════════════════════════════════════

    server.tool(
      "desktop_clipboard",
      [
        "Read, write, or clear the macOS clipboard.",
        "To paste text into apps, use desktop_paste instead (handles save/restore automatically).",
      ].join("\n"),
      {
        action: z
          .enum(["get", "set", "clear"])
          .describe("'get' reads, 'set' writes, 'clear' empties"),
        text: z.string().optional().describe("Text to write (required for action='set')"),
      },
      async ({ action, text }) => {
        const args = ["clipboard", "--action", action];
        if (text) args.push("--text", text);
        return json(await peekaboo(args));
      }
    );

    server.tool(
      "desktop_menu",
      [
        "Click a menu item or list menu tree. Supports fuzzy app name matching.",
        "For click: path as array ['File', 'Save'] (joins as 'File > Save'). For list: omit path.",
        "Use as alternative when desktop_click fails on toolbar buttons.",
      ].join("\n"),
      {
        action: z
          .enum(["click", "list"])
          .optional()
          .default("click")
          .describe("'click' activates, 'list' shows menu tree"),
        path: z
          .array(z.string())
          .optional()
          .describe("Menu path for click (e.g. ['File', 'Save'])"),
        app: z.string().optional().describe("App name. Omit for frontmost."),
      },
      async ({ action, path, app }) => {
        checkBlacklist(app);
        if (action === "list") {
          const args = ["menu", "list"];
          if (app) args.push("--app", app);
          return json(await peekaboo(args));
        }
        if (!path || path.length === 0)
          throw new Error("Provide menu path for click action.");
        const args = ["menu", "click", "--path", path.join(" > ")];
        if (app) args.push("--app", app);
        return json(await peekaboo(args));
      }
    );

    // ═══════════════════════════════════════════════════════════
    // LIST & DISCOVERY
    // ═══════════════════════════════════════════════════════════

    server.tool(
      "desktop_list_apps",
      "List running macOS apps with names, PIDs, bundle IDs. Use names as 'app' param in other tools.",
      {},
      async () => json(await peekaboo(["list", "apps"]))
    );

    server.tool(
      "desktop_list_windows",
      "List open windows for an app. Returns titles, bounds (x,y,w,h), indices.",
      {
        app: z.string().optional().describe("App name. Omit for frontmost."),
      },
      async ({ app }) => {
        checkBlacklist(app);
        let targetApp = app;
        if (!targetApp) {
          try {
            const { stdout } = await execa("osascript", [
              "-e",
              'tell application "System Events" to get name of first application process whose frontmost is true',
            ]);
            targetApp = stdout.trim();
          } catch {
            throw new Error("Could not detect frontmost app. Specify app name.");
          }
        }
        return json(await peekaboo(["list", "windows", "--app", targetApp]));
      }
    );

    // ═══════════════════════════════════════════════════════════
    // OPEN
    // ═══════════════════════════════════════════════════════════

    server.tool(
      "desktop_open_url",
      "Open a URL or file with default or specified app.",
      {
        url: z.string().describe("URL or file path"),
        app: z.string().optional().describe("App to open with"),
      },
      async ({ url, app }) => {
        checkBlacklist(app);
        const args = ["open", url];
        if (app) args.push("--app", app);
        return json(await peekaboo(args));
      }
    );
  }
}
