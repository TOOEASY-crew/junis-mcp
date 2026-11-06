# Changelog

## 0.5.3 — 2026-11-06

### Security
- **Relay mode always protects the local HTTP server with a bearer token.** `npx junis` (foreground or
  background) generates a token on the first start without one, prints it once and saves it as
  `local_token` in `~/.junis/config.json`; `--no-token` is refused in relay mode. A background service
  started from an older config without a saved token uses a token that is not written anywhere until
  `npx junis` has run once. `--local` behaves as before: the token is optional on loopback.

## 0.5.2 — 2026-11-05

### Security
- The audit log now records failed calls too: a block edit or file share that fails, a process kill
  whose `kill` or `taskkill` fails, and a cron create or delete that changed nothing (duplicate command,
  no matching job) are logged with outcome `error`. As before, no file text or command output is written.

### Changed
- The MCP server name in the CLI help and the local endpoint hint is `junis-device`, matching the README
  and `setup-mac.sh`. The npm package is still `junis`.
- CLI notifications and `setup-mac.sh` messages are in English.

### Documentation
- README: what `npx` installs, who can reach the local server without a token, the upload hosts, what the
  policy file does not cover, what `logout` leaves behind, the exact audit log coverage and the Windows
  `sh` requirement. SECURITY.md says which traffic the server check covers.

## 0.5.1 — 2026-11-05

### Documentation
- README rewritten. The per-tool reference moved to `docs/TOOLS.md`. No code changes.

## 0.5.0 — 2026-11-05

### Security
- **Server URL guard.** `JUNIS_API_URL`, `JUNIS_WS_URL` and `JUNIS_WEB_URL` are only accepted for
  `junis.ai` / `*.junis.ai` over `https`/`wss`, or for loopback addresses (`localhost`, `127.0.0.1`, `::1`)
  with any scheme. Any other host is refused at startup with a clear error unless
  `JUNIS_ALLOW_CUSTOM_SERVER=1` is set, in which case a red warning names the host. The daemon service files
  (launchd plist, systemd unit) persist URL variables only when they passed the guard, and every value is
  escaped so a crafted path or variable cannot inject keys or directives.
- **Local policy file** `~/.junis/policy.json` (optional, see README): `deny_read_paths` (default: SSH keys,
  AWS credentials, GnuPG, macOS keychains, browser `Cookies`/`Login Data` databases and `~/.junis/config.json`
  are refused by `read_file`, `edit_block`, `share_file` and `browser_upload`), `deny_command_patterns`
  for `execute_command` and `cron_create` (built-in: only destructive forms such as `rm -rf /`, `mkfs`,
  `dd of=/dev/…`, the fork bomb and redirects to a raw disk), and `read_only: true` (refuses the tools that
  write files, run commands, change cron or processes, upload files or change and run notebooks).
  Users can override every list (`"deny_read_paths": []` turns the read guard off).
- **Audit log** `~/.junis/logs/audit.jsonl` (owner-only, 5 MB rotation, `JUNIS_AUDIT_LOG=0` to disable):
  one line per `execute_command`, `write_file`, `edit_block`, `kill_process`, `cron_create`, `cron_delete`,
  `share_file` and `browser_upload` with the tool, a short argument summary, the time and the outcome.
  File contents and command output are never logged.
- **Uploads** (`share_file`, large screenshots) only PUT over `https` to `junis.ai`, `*.junis.ai`, the
  object storage wildcard listed in `src/relay/upload.ts`, or hosts you add in `JUNIS_UPLOAD_HOSTS`. With
  `JUNIS_ALLOW_CUSTOM_SERVER=1` any https host is accepted. Loopback addresses are always accepted, over http
  too, for local development. `authorization`/`cookie` headers in `required_headers` are dropped.
- The config-save failure message no longer prints the device token; it prints the path and a redacted config.
- `search_code` passes the pattern and directory after `--`, `kill_process` accepts only positive integer
  PIDs, temporary files use private `mkdtemp` directories, and the Windows scheduled task runs with limited
  privileges (`/RL LIMITED`) with quoted paths.
- `location_get` IP fallback uses an `https` source (`ipapi.co`) instead of plain `http`.

### Changed
- Requires Node.js 20.12 or newer. Earlier releases declared Node 18 but their dependencies already needed 20.12.
- `read_file` and `share_file` refuse files larger than 50 MB (`JUNIS_MAX_FILE_MB` to change).
- `execute_command` with `background: true` starts the process detached and returns its PID.
- The `execute_command` tool description no longer tells the model to skip confirmation.
- The peekaboo (desktop tools) Homebrew auto-install prints what it is about to run first;
  `JUNIS_NO_AUTO_INSTALL=1` skips it.
- The MCP server reports the real package version instead of `0.1.0`.
- `playwright-core` dependency pinned to `^1.50.0`.

### Added
- `LICENSE` (MIT), `SECURITY.md`, GitHub Actions CI and tag-based npm publish workflows.
- README in English with the endpoints, the complete tool list and a "Security and privacy" section.

## 0.4.10 — 2026-10-06

### Fixed
- Device uploads (`upload_url_request`) now send exactly the headers the server returns in
  `required_headers` with the presigned PUT. Some object storage backends require extra headers on the
  PUT; the old client hard-coded only `Content-Type`, so uploads to such a backend failed with `400`. Servers that do
  not send `required_headers` get the previous behaviour.

## 0.4.9 — 2026-10-06

### Fixed
- `browser_wait` with a `loadState` no longer fails when the page is already loaded but the load-state
  event never fires again (for example `networkidle` on a page that keeps polling, or a wait issued after
  the page finished loading). On a load-state timeout it checks `document.readyState`: `domcontentloaded`
  counts as met at `interactive` or `complete`, `load` and `networkidle` at `complete`. It then returns
  "Wait condition met (best-effort) … do not repeat" instead of an error. Text/selector waits and
  non-timeout errors are unchanged, and a page that is still loading keeps the original timeout error.

### Added
- `browser_wait` accepts `timeoutMs` (integer, 500–120000) to cap a single wait. Omitting it keeps the
  previous 20-second default, so existing callers are unaffected.

## 0.4.8 — 2026-09-30

### Security
- Device login (`npx junis`) now proves it is the CLI that started the login: it sends
  `poll_challenge` = base64url(SHA-256(verifier)) with `/api/auth/device/start` and the verifier in
  `X-Poll-Verifier` on every poll. Newer servers hand the device token only to that caller,
  once. A leaked approval link (the code in the URL) is no longer enough to take the token. Older
  servers ignore both and keep working.
- A local server started **without** a token refuses browser requests (`POST /mcp` carrying an `Origin`
  header, `403`), including pages served from another localhost port. Previously any local web page
  (for example a dev server with an XSS) could call `execute_command`. Coding agents, the CLI and the
  cloud relay send no `Origin` and are unaffected; to call the server from a browser, start it with
  `--token <value>` and send `Authorization: Bearer <value>`.
- `~/.junis` is owner-only (`0700`) and `config.json` is created `0600` from the start (an existing
  `0644` file is narrowed before the new token is written). Existing installs are tightened on the next
  start.

## 0.4.7 — 2026-09-29

### Security
- Upgrade if you run 0.4.6 or earlier: those versions expose every device tool to the local network.
- The local MCP server (`--local`, and the loopback server behind the cloud relay) now binds to
  **127.0.0.1 / ::1 by default** instead of every network interface. Previously anyone on the same
  network could call every device tool (`execute_command`, `write_file`, …) without a credential.
- New `--host <addr>` to expose the server on another interface. Any non-loopback address requires a
  bearer token: pass `--token <value>`, or one is generated, printed once and saved to
  `~/.junis/config.json` (`local_host`, `local_port`, `local_token`). Every `POST /mcp` must then send
  `Authorization: Bearer <token>`; without it the answer is `401` with `WWW-Authenticate: Bearer`.
- Host-header check on every path (DNS-rebinding defence); CORS headers only for loopback origins;
  `POST /mcp` from a foreign browser Origin is refused (`403`). The mock OAuth endpoints are not served
  while a token is required (they minted tokens to anyone).
- `npx junis logout` now revokes the device token on the server (`POST /api/auth/device/revoke`; older
  servers answer 404 and the CLI says so), stops the background service and removes auto-start before
  clearing credentials. Previously it only deleted the local file while the daemon kept running and
  re-saved it on its next re-authentication.

### Changed
- The background service reads host/port/token from `~/.junis/config.json`, so a daemon started after
  `--port`/`--host` binds the same way (launchd/systemd/schtasks never forwarded flags).
- The printed endpoint shows the port actually bound.

### Fixed
- macOS allows binding `127.0.0.1:<port>` while another process listens on `*:<port>` (e.g. a local
  Next.js/React dev server on 3000) with no "address in use" error, so the loopback bind silently took over
  the browser's `localhost:<port>`. Before binding a loopback port the server now checks whether something
  already answers on `127.0.0.1`/`::1` and moves to the next port, like a real "in use" error.
- `logout`: the server answers `token_revoked: false` for device tokens issued before revocation support
  (no `jti`); the CLI now says the device was marked revoked but that token stays valid until it expires,
  instead of "Device token revoked". The revoke request has a 10 s timeout so a silent server cannot stall
  logout (local cleanup always runs).
- `logout` after the device was deleted in the web app: newer servers revoke the presented token
  first and answer `404 {"detail": "Device not found", "token_revoked": true}`; the CLI reports the token as
  revoked instead of "older server". A 404 without `token_revoked` is still treated as an older server.

### Migration
- Same-machine use (Claude Code, Cursor, … pointing at `http://localhost:<port>/mcp`) needs no change.
- To reach the server from another machine, start it with `--host <addr>` and send the printed token.

### Tests
- First test suite: `npm test` (Node's built-in runner via `tsx`, dev dependency only) covering binding,
  token enforcement, Host/Origin/CORS rules, config persistence, revoke and logout ordering.
