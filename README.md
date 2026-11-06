# junis

[![npm version](https://img.shields.io/npm/v/junis)](https://www.npmjs.com/package/junis)
[![CI](https://github.com/TOOEASY-crew/junis-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/TOOEASY-crew/junis-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/junis)](./LICENSE)

A local MCP server that lets AI agents work on your computer: shell, files, a real browser, Jupyter
notebooks, camera, clipboard and screen, and native apps on macOS.

`npx junis` connects your computer to agents on [Junis](https://junis.ai), a hosted platform for squads
of AI agents, through a relay. The same package runs as a plain [MCP](https://modelcontextprotocol.io)
server for Claude Code, Claude Desktop, Codex, Cursor or any other MCP client on the machine, without a
Junis account. A local policy file sets which paths and commands are off limits, a local audit log
records each shell command, file write and file share, and `npx junis logout` revokes the device.

## Install

Requires Node.js 20.12 or newer. `npx` runs the package without a global npm install. Background mode
registers a user service, and on macOS the local server installs peekaboo with Homebrew when it is
missing, unless `JUNIS_NO_AUTO_INSTALL=1` is set. The policy file, audit log and server check
described here need junis 0.5.0 or later (`npx junis@latest`).

```bash
npx junis
```

1. Choose Foreground to run in this terminal, or Background to install a user service that starts when
   you log in.
2. Your browser opens a junis.ai page. Sign in and approve the device. If the browser does not open,
   use the link printed in the terminal.
3. The terminal shows the device name and `Cloud relay connected`. On your first login it also shows
   the workspace and the agent that were created for this device.
4. Open [junis.ai](https://junis.ai), choose that agent and ask it something only your machine can
   answer:

   > How much free disk space does this computer have, and what are the five largest files in my
   > Downloads folder?

   The agent runs this on your machine through the device tools and replies with what it found.

```bash
npx junis status    # whether it is running and which device is registered
npx junis stop      # stop the background service and remove auto-start
npx junis logout    # revoke the device on the server and delete local credentials
```

### Without a Junis account

In these modes `junis` does not connect to junis.ai.

```bash
# Claude Code: the client starts junis over stdio
claude mcp add --scope user junis-device -- npx -y junis --stdio
```

Other clients, in their MCP configuration:

```json
{
  "mcpServers": {
    "junis-device": { "command": "npx", "args": ["-y", "junis", "--stdio"] }
  }
}
```

One long-lived server that several clients share, over HTTP:

```bash
npx junis --local     # http://localhost:3000/mcp, reachable from this machine only
claude mcp add --transport http junis-device http://localhost:3000/mcp
```

In relay mode the local server always requires a bearer token (generated once and saved to
`~/.junis/config.json`; printed at start). `--local` keeps the token optional. See
[Local HTTP server](#local-http-server).

## Examples

You write the agents and their instructions in Junis. Each example lists the `junis` tools it relies
on.

- Daily metrics report. A Junis squad runs every morning on a schedule while this machine is connected
  in background mode. It opens your company dashboard in a browser profile that is already signed in,
  reads the numbers, saves a screenshot and returns a short report with a download link.
  `browser_start` with a persistent profile, `browser_navigate`, `browser_snapshot`,
  `browser_screenshot`, `write_file`, `share_file`.
- Bug reproduction with a recording. An agent checks out the branch named in a bug report, starts the
  app, records the screen while it walks through the steps in the browser, and attaches the video to
  its answer. `execute_command`, `screen_record`, `browser_navigate`, `browser_click`, `browser_type`,
  `share_file`.
- Notebook analysis. A research agent finds the notebooks and CSV files in a project folder, changes
  the date range in one cell, runs the notebook and reports the new figures. `list_directory`,
  `search_code`, `read_file`, `notebook_read`, `notebook_edit_cell`, `notebook_execute`.
- A desktop app without an API (macOS). An agent opens a native app, reads its interface through the
  accessibility tree, fills in a form, exports a file from the menu and checks the result on a
  screenshot. `desktop_open_app`, `desktop_see`, `desktop_click`, `desktop_type`, `desktop_menu`,
  `desktop_screenshot`.
- Recurring jobs. An agent sets up a nightly backup of a folder, lists the jobs it created and removes
  them when the project ends. Each cron command is checked against your command rules and written to
  the audit log. `cron_create`, `cron_list`, `cron_delete`.

## Modes

| Mode | Command | What it does |
|------|---------|--------------|
| Relay, foreground | `npx junis`, then *Foreground* (or `npx junis --foreground`) | Logs in through the browser, then keeps a WebSocket to junis.ai open in this terminal. The token-protected local HTTP server also runs. `Ctrl+C` stops it. |
| Relay, background | `npx junis`, then *Background* | The same, registered as a user service that starts at login: launchd on macOS, systemd on Linux, a scheduled task on Windows. The token-protected local HTTP server runs in the service. |
| Local HTTP | `npx junis --local` | MCP server on `127.0.0.1:3000` and nothing else. If the port is taken, the next free port is used and printed. |
| stdio | `npx junis --stdio` | The MCP client starts `junis` and talks over stdin and stdout. No network server. |

Options for the local HTTP server (`--local` and both relay modes):

- `--port <number>` sets the port.
- `--host <addr>` binds another interface, for example `--host 0.0.0.0`. Any address other than
  loopback requires a bearer token. Pass one with `--token <value>`, or `junis` generates one, prints it
  once and saves it to `~/.junis/config.json`. Clients then send `Authorization: Bearer <token>`.
- `--no-token` forgets a saved token (`--local` on loopback only; refused in relay mode).
- `--port`, `--host` and `--token` are remembered, so the background service binds the same way.

Other commands: `npx junis --reset` (log in again), `npx junis --version`, `npx junis --help`.

## Tools

| Group | Tools | Examples |
|------|------:|----------|
| Files and shell | 9 | `execute_command`, `read_file`, `write_file`, `edit_block`, `search_code`, `share_file` |
| Cron (macOS, Linux) | 3 | `cron_create`, `cron_list`, `cron_delete` |
| Browser | 19 | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_pdf` |
| Notebook | 5 | `notebook_read`, `notebook_add_cell`, `notebook_execute` |
| Device | 7 | `camera_capture`, `screen_record`, `clipboard_read`, `notification_send` |
| Desktop (macOS) | 19 | `desktop_see`, `desktop_click`, `desktop_type`, `desktop_menu` |

`--local` and relay mode register all six groups. The desktop group needs macOS and
[peekaboo](https://github.com/steipete/Peekaboo). `--stdio` registers every group except desktop.
The browser group drives an installed Chrome, Brave, Edge or Chromium and addresses elements by the
`ref` numbers from `browser_snapshot`. `share_file` returns a download link only in relay mode. Every
tool, with what it does, is listed in
[docs/TOOLS.md](https://github.com/TOOEASY-crew/junis-mcp/blob/main/docs/TOOLS.md).

## Security and privacy

`junis` runs with your user account's permissions. An agent connected to it can ask for anything you
could do in a terminal, a browser or, on macOS, with the mouse and keyboard.

Every tool runs on this machine. Commands run under `sh -c`, files are read and written directly, and
the browser is the one you installed. In `--local` and `--stdio` mode `junis` does not contact
junis.ai. Other network traffic comes from what the tools are asked to do, such as a command that
downloads a file, a page the browser opens or the IP-based location fallback. On macOS, `junis` may
also run the one-time Homebrew install of peekaboo described under [Requirements](#requirements).

### Data sent in relay mode

In relay mode, junis.ai receives the tool calls your agents make and what the tools return: commands
and their output, the contents of files an agent reads, screenshots, camera photos, page snapshots,
clipboard text, and your location when asked. Junis passes them to the language model the agent runs
on, so they also reach that model's provider.

Images and file contents larger than 1 MB, and every `share_file`, are uploaded to a storage URL the
server issues. `junis` uploads only over https to `junis.ai`, `*.junis.ai`, `*.blob.core.windows.net`
(the platform's object storage) or hosts you add in `JUNIS_UPLOAD_HOSTS`. With
`JUNIS_ALLOW_CUSTOM_SERVER=1` any https host is accepted. Loopback addresses are always accepted, over
http too, for local development. Uploads never carry `authorization` or
`cookie` headers.

### Which servers get your token

At startup `junis` checks every server URL it will use:

- `junis.ai` and `*.junis.ai` are accepted over `https://` and `wss://` only.
- Loopback addresses (`localhost`, `127.0.0.1`, `::1`) are accepted with any scheme, for local
  development.
- Any other host is refused unless you set `JUNIS_ALLOW_CUSTOM_SERVER=1`. Then `junis` prints a red
  warning naming the host on every start, because that server receives your token and every tool
  result.
- A URL with a user name or password in it is always refused.

The background service stores a URL variable only if it passed this check.

### Credentials

Approving the device in the browser issues a device token. It is handed only to the CLI process that
started the login and stored in `~/.junis/config.json` (directory `0700`, file `0600`).
`npx junis logout` revokes it on the server (and says so when the server could not), stops the
background service and deletes the local credentials. Cron entries an agent created stay in your
crontab. They are marked with a `# junis:<label>` or `# junis-cron` comment in `crontab -l`. You can
also remove the device in the junis.ai web app. `npx junis stop` closes the connection and keeps the
credentials for the next start.

### Local HTTP server

The local server binds to `127.0.0.1` and `::1` by default. Relay mode starts this server too, in the
foreground and in the background service, and there it always requires a bearer token: the first
`npx junis` generates one, prints it once and saves it as `local_token` in `~/.junis/config.json`
(`--token <value>` sets your own). A background service started from an older config without a saved
token uses a token that is not written anywhere, so no program can call it until `npx junis` has run
once. With `--local` the token is optional: without one, any program on this machine, under any user
account, can call the tools, so on a shared machine start with `--token <value>`. Binding any other
address requires a bearer token. Even without a token, requests that come from a web page (they carry
an `Origin` header) are refused, so a page open in your browser cannot call the tools. The `Host`
header is checked on every request.

### Policy file

`~/.junis/policy.json` is optional. A missing or invalid file means the defaults below. The file is
read again on every call, so changes apply immediately. A refused call returns an error to the agent
that names the rule.

```json
{
  "read_only": false,
  "deny_read_paths": [
    "~/.ssh/id_*", "~/.ssh/*_key", "~/.ssh/*.pem", "~/.aws/credentials", "~/.gnupg/**", "~/Library/Keychains/**",
    "~/.junis/config.json",
    "~/Library/Application Support/{Google/Chrome,BraveSoftware,Microsoft Edge}/**/Cookies",
    "~/Library/Application Support/{Google/Chrome,BraveSoftware,Microsoft Edge}/**/Login Data",
    "~/.config/{google-chrome,chromium}/**/Cookies",
    "~/.config/{google-chrome,chromium}/**/Login Data",
    "~/.junis-kit/credentials.json", "~/.kube/config", "~/.azure/**", "~/.config/gh/hosts.yml",
    "~/.npmrc", "~/.docker/config.json", "~/.netrc", "~/.pgpass", "~/.git-credentials",
    "~/Library/Application Support/Firefox/**/cookies.sqlite",
    "~/Library/Application Support/Firefox/**/logins.json",
    "~/.mozilla/firefox/**/cookies.sqlite", "~/.mozilla/firefox/**/logins.json"
  ],
  "deny_command_patterns": [],
  "builtin_command_guards": true
}
```

| Setting | Checked for | Notes |
|---------|-------------|-------|
| `deny_read_paths` | `read_file`, `edit_block`, `share_file`, `browser_upload`, `list_directory`, `search_code` (the directory, and matching lines from denied files are dropped), `notebook_read`, `notebook_edit_cell`, `notebook_execute`, `browser_navigate` with a `file://` URL | Globs with `*`, `**`, `?`, `{a,b}` and `~`. Symlinks are resolved first. Case is ignored on macOS and Windows. Your list replaces the default, and `[]` turns the check off. |
| `deny_command_patterns` | `execute_command`, `cron_create` | Regular expressions matched against the command. |
| `builtin_command_guards` | `execute_command`, `cron_create` | On by default. Refuses only destructive forms: `rm -rf /`, `mkfs`, `dd … of=/dev/…`, the fork bomb and redirects to a raw disk device. |
| `read_only` | `write_file`, `edit_block`, `execute_command`, `cron_create`, `cron_delete`, `kill_process`, `browser_upload`, `share_file`, `notebook_edit_cell`, `notebook_add_cell`, `notebook_delete_cell`, `notebook_execute` | `true` refuses these 12 tools. |

What the policy file does not cover:

- Path rules check the path a file tool is given. They do not look inside shell commands, so
  `execute_command` can still read a listed file unless a command rule or `read_only` stops it.
- `write_file`, `list_directory`, `search_code` and `notebook_read` are not path-checked.
- Browser, desktop, clipboard, camera, screen, location, audio and notification tools are not limited
  by the policy file, including with `read_only: true`.
- `browser_cookies` and `browser_storage` read the cookies and site storage of the profile the browser
  runs with, whatever the path rules say.
- Unless `read_only` is true, an agent can rewrite `~/.junis/policy.json` or the audit log with
  `write_file` or a command.

For a hard boundary, run `junis` under a separate OS user account that cannot see your private files.

### Audit log

`~/.junis/logs/audit.jsonl` is owner-only and rotates to `audit.jsonl.1` at 5 MB. Each shell command,
file write, block edit, file share, process kill, cron change and browser upload is logged with its
outcome: `ok`, `error` or `denied` (refused by the policy). Notebook edits and runs are logged only when
`read_only` refused them, and file reads only when a path rule refused them. Other browser actions,
desktop actions and device tools are not logged. Each line has the time, the tool, a short summary of
the arguments (path, command or PID) and the outcome. File contents and command output are never
written. `JUNIS_AUDIT_LOG=0` turns the log off.

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## Configuration

| Variable | Default | Used for |
|----------|---------|----------|
| `JUNIS_API_URL` | `https://junis.ai` | Device login (`/api/auth/device/*`), the workspace check at start, logout |
| `JUNIS_WS_URL` | derived from the API URL: `wss://junis.ai` | Relay connection: `wss://junis.ai/ws/devices/{device_key}` |
| `JUNIS_WEB_URL` | unset, the login URL from the server is used | Origin of the login page. A localhost `JUNIS_API_URL` implies `http://localhost:3000`. |
| `JUNIS_ALLOW_CUSTOM_SERVER` | unset | `1` accepts a server other than junis.ai. See [Which servers get your token](#which-servers-get-your-token). |
| `JUNIS_UPLOAD_HOSTS` | unset | Extra upload hosts, comma-separated, as `host` or `*.suffix` |
| `JUNIS_MAX_FILE_MB` | `50` | Size limit for `read_file` and `share_file` |
| `JUNIS_AUDIT_LOG` | `1` | `0` turns the audit log off |
| `JUNIS_NO_AUTO_INSTALL` | unset | `1` skips the Homebrew install of peekaboo |

The three URL variables go through the server check above.

## Requirements

- Node.js 20.12 or newer.
- Windows: `sh` on PATH (for example Git Bash) for the shell tools.
- Browser tools: Chrome, Brave, Edge or Chromium installed.
- Desktop tools: macOS 15 or newer and `peekaboo`. On first start `junis` installs it with Homebrew and
  prints the command first. Set `JUNIS_NO_AUTO_INSTALL=1` to skip that and install it yourself with
  `brew tap steipete/tap && brew install peekaboo`. Give your terminal app Accessibility and Screen
  Recording in System Settings, Privacy & Security. In background mode a host app such as Peekaboo.app
  or Claude Desktop holds those permissions instead.
- Camera: `imagesnap` on macOS (`brew install imagesnap`), `fswebcam` on Linux, `ffmpeg` on Windows. In
  background mode on macOS, give `node` Camera access.
- Screen recording and audio on Windows and Linux: `ffmpeg`.
- Notebook execution: Jupyter (`pip install jupyter`).
- Precise location on macOS: `CoreLocationCLI` (`brew install --cask corelocationcli`). Without it,
  `location_get` returns an IP-based estimate.

On macOS, [`setup-mac.sh`](./setup-mac.sh) installs whatever is missing among Homebrew, Node.js, the
optional tool dependencies above and Claude Code, then offers to register it with Claude Code as
`junis-device`. Some steps use `sudo`. Read it first, then run it from a file, because it asks
questions:

```bash
curl -fsSL https://raw.githubusercontent.com/TOOEASY-crew/junis-mcp/main/setup-mac.sh -o setup-mac.sh
chmod +x setup-mac.sh && ./setup-mac.sh
```

## Part of Junis

[Junis](https://junis.ai) runs squads of AI agents: an orchestrator with sub-agents that work on
request or on a schedule. Squads can use knowledge graphs, a wiki, long-term memory, MCP servers and
app connections, and choose from more than 50 models across OpenAI, Anthropic, Google and open-weight
families (as of November 2026). `junis` connects those agents to your computer. To design, run and
debug squads from the coding agent you already use, see
[junis-kit](https://github.com/TOOEASY-crew/junis-kit).

## Development

```bash
npm ci
npm run type-check
npm test            # node --test via tsx
npm run build       # tsup, output in dist/
node dist/cli/index.js --help
```

Bug reports and pull requests are welcome in
[GitHub issues](https://github.com/TOOEASY-crew/junis-mcp/issues).

## License

[MIT](./LICENSE). Copyright (c) 2026 TOOEASY Inc.

Junis is a trademark of TOOEASY Inc.

Contact: [contact@junis.ai](mailto:contact@junis.ai)
