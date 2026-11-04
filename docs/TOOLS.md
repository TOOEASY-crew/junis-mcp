# Tools

`--local` and relay mode register all six groups below. The desktop group is added only on macOS with
[peekaboo](https://github.com/steipete/Peekaboo) available. `--stdio` registers every group except
desktop. `share_file` returns a download link only in relay mode.

## Files and shell (9)

| Tool | Description |
|------|-------------|
| `execute_command` | Run a shell command (`sh -c`) with a timeout. `background: true` starts it detached and returns the PID. |
| `read_file` | Read a file as UTF-8 or base64, up to `JUNIS_MAX_FILE_MB`. |
| `write_file` | Create or overwrite a file. Parent directories are created. |
| `edit_block` | Replace an exact block of text in a file, once or everywhere. |
| `list_directory` | List files and subdirectories. |
| `search_code` | Regex search across files with ripgrep, or a glob fallback when `rg` is not installed. |
| `list_processes` | Top 30 processes by CPU. |
| `kill_process` | Stop a PID with SIGTERM, then SIGKILL after 3 seconds, or SIGKILL directly. |
| `share_file` | Upload a local file through the relay and return a download link. |

## Cron (3)

Uses `crontab`, so it works on macOS and Linux.

| Tool | Description |
|------|-------------|
| `cron_create` | Add a crontab entry with a schedule, a command and an optional label. |
| `cron_list` | List crontab entries with their IDs. |
| `cron_delete` | Remove an entry by ID or by command. |

## Browser (19)

Drives a browser that is already installed: Chrome, Brave, Edge or Chromium. Nothing else is
downloaded. Elements are addressed by the `ref` numbers from `browser_snapshot` instead of CSS
selectors.

| Tool | Description |
|------|-------------|
| `browser_start` | Launch a browser, headless or visible, optionally with a persistent profile. Or connect to a running Chrome over CDP. |
| `browser_stop` | Close the browser. |
| `browser_navigate` | Open a URL. |
| `browser_snapshot` | Accessibility-tree snapshot of the page with element refs. |
| `browser_click` | Click an element. |
| `browser_type` | Type text into an element. |
| `browser_fill` | Fill a form field. |
| `browser_select` | Choose an option in a `<select>`. |
| `browser_press` | Press a key or key combination. |
| `browser_hover` | Hover over an element. |
| `browser_drag` | Drag one element onto another. |
| `browser_upload` | Set files on an `<input type="file">`. |
| `browser_screenshot` | Screenshot of the page, the viewport or one element. |
| `browser_pdf` | Save the page as PDF. |
| `browser_evaluate` | Run JavaScript in the page. |
| `browser_wait` | Wait for text, a URL, a load state or a delay (`timeoutMs`, 500 to 120000 ms). |
| `browser_cookies` | Read or set cookies. |
| `browser_storage` | Read or write `localStorage` and `sessionStorage`. |
| `browser_dialog` | Set how the next alert, confirm or prompt is answered. |

## Notebook (5)

| Tool | Description |
|------|-------------|
| `notebook_read` | List the cells of an `.ipynb` file. |
| `notebook_edit_cell` | Replace a cell's source. |
| `notebook_add_cell` | Insert a code or markdown cell. |
| `notebook_delete_cell` | Delete a cell. |
| `notebook_execute` | Run the whole notebook in place with `nbconvert`. Needs Jupyter. |

## Device (7)

| Tool | Description |
|------|-------------|
| `camera_capture` | Take a photo: `imagesnap` on macOS, `ffmpeg` on Windows, `fswebcam` on Linux. |
| `notification_send` | Show a native desktop notification. |
| `clipboard_read` | Read the clipboard text. |
| `clipboard_write` | Replace the clipboard text. |
| `screen_record` | Start or stop a full-screen MP4 recording: `screencapture -v` on macOS, `ffmpeg` elsewhere. |
| `location_get` | Location from CoreLocation on macOS, otherwise an IP-based estimate from `https://ipapi.co`. |
| `audio_play` | Play an audio file with `afplay` or `ffplay`. |

## Desktop, macOS only (19)

Native app automation through peekaboo: `desktop_see`, `desktop_screenshot`, `desktop_click`,
`desktop_type`, `desktop_paste`, `desktop_hotkey`, `desktop_press`, `desktop_scroll`, `desktop_move`,
`desktop_drag`, `desktop_open_app`, `desktop_app_quit`, `desktop_window`, `desktop_dialog`,
`desktop_clipboard`, `desktop_menu`, `desktop_list_apps`, `desktop_list_windows`, `desktop_open_url`.
