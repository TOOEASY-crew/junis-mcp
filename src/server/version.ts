// src/server/version.ts — the package version, read from package.json so the MCP server identity and the CLI
// banner never drift from the published version. Works from src/ (tsx) and from the dist/ bundles alike:
// src/server/*.ts, dist/server/*.js and dist/cli/index.js all sit two directories below the package root.
import { createRequire } from "module";

const PACKAGE_NAME = "junis";

export function readPackageVersion(): string {
  const req = createRequire(import.meta.url);
  for (const candidate of ["../../package.json", "../package.json", "../../../package.json"]) {
    try {
      const pkg = req(candidate) as { name?: string; version?: string };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") return pkg.version;
    } catch {
      // try the next location
    }
  }
  return "0.0.0";
}

export const VERSION = readPackageVersion();
