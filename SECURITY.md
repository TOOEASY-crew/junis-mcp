# Security Policy

`junis` runs on a user's machine with that user's permissions and executes what an AI agent asks for.
We take reports about it seriously.

## Reporting a vulnerability

Email **contact@junis.ai** with a description, the affected version (`npx junis --version`) and steps to
reproduce. Please do not open a public issue for security problems. We acknowledge reports within three
business days and keep you informed until a fix is released.

## Supported versions

Only the latest published version on npm receives security fixes. Run `npx junis@latest`, or update the
pinned version in your MCP client configuration.

## What the CLI does to protect you

- Sends the device token and tool results only to `junis.ai` (or a loopback address) unless
  `JUNIS_ALLOW_CUSTOM_SERVER=1` is set. Tools themselves can reach any host the agent asks for.
- Reads an optional local policy file `~/.junis/policy.json` (`deny_read_paths`, `deny_command_patterns`,
  `read_only`) with safe defaults, and keeps a local audit log in `~/.junis/logs/audit.jsonl`.
- Stores credentials in `~/.junis/config.json` with owner-only permissions.

See the "Security and privacy" section of the README for details.
