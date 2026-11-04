#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  Junis MCP: fully automated macOS setup script
#  Run this one script on a new Mac (Intel / Apple Silicon) to set up
#  everything the npx junis tools need,
#  and install Claude Code (the claude CLI) as well.
#
#  Usage (the script has interactive prompts, so save it to a file before running):
#    curl -fsSL https://raw.githubusercontent.com/TOOEASY-crew/junis-mcp/main/setup-mac.sh -o setup-mac.sh
#    chmod +x setup-mac.sh && ./setup-mac.sh
#
#  Do not pipe it as curl ... | bash (the read prompts will not work)
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colors & helpers ────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ok()   { echo -e "  ${GREEN}[ok] $1${NC}"; }
skip() { echo -e "  ${YELLOW}[skip] $1${NC}"; }
info() { echo -e "  ${BLUE}[info] $1${NC}"; }
warn() { echo -e "  ${YELLOW}[warn] $1${NC}"; }
fail() { echo -e "  ${RED}[fail] $1${NC}"; }

section() {
  echo ""
  echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}${BOLD}  $1${NC}"
  echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════${NC}"
}

# ── Architecture detection ──────────────────────────────────────────────
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  BREW_PREFIX="/opt/homebrew"
  CHIP="Apple Silicon"
else
  BREW_PREFIX="/usr/local"
  CHIP="Intel"
fi

section "Junis MCP: macOS setup"
echo ""
echo -e "  Chip: ${BOLD}${CHIP}${NC} (${ARCH})"
echo -e "  macOS: $(sw_vers -productVersion 2>/dev/null || echo 'unknown')"
echo -e "  Homebrew prefix: ${BREW_PREFIX}"
echo ""

# ── 0. Xcode Command Line Tools ────────────────────────────────
section "STEP 0 · Xcode Command Line Tools"

if xcode-select -p &>/dev/null; then
  ok "Xcode CLT already installed ($(xcode-select -p))"
else
  info "Installing Xcode Command Line Tools... (click 'Install' in the popup)"
  xcode-select --install
  # Wait for the install to finish
  echo ""
  read -rp "  Press Enter once the Xcode CLT install has finished... "
  if xcode-select -p &>/dev/null; then
    ok "Xcode CLT installed"
  else
    fail "Xcode CLT is required. Install it, then run this script again."
    exit 1
  fi
fi

# ── 1. Homebrew ────────────────────────────────────────────────
section "STEP 1/7 · Install Homebrew"

if command -v brew &>/dev/null; then
  ok "Homebrew already installed ($(brew --version | head -1))"
else
  info "Installing Homebrew... (this also installs the Xcode Command Line Tools)"
  # Homebrew's official install command, unchanged (https://brew.sh); the install script is maintained by the Homebrew project.
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  # Put brew on PATH (current session)
  eval "$($BREW_PREFIX/bin/brew shellenv)"

  # Persist it in .zshrc (only once)
  SHELL_RC="$HOME/.zshrc"
  BREW_EVAL="eval \"\$(${BREW_PREFIX}/bin/brew shellenv)\""
  if ! grep -qF "$BREW_PREFIX/bin/brew shellenv" "$SHELL_RC" 2>/dev/null; then
    echo "" >> "$SHELL_RC"
    echo "# Homebrew" >> "$SHELL_RC"
    echo "$BREW_EVAL" >> "$SHELL_RC"
    info "Added Homebrew to PATH in .zshrc"
  fi

  ok "Homebrew installed"
fi

# Make brew available in the current session as well
eval "$($BREW_PREFIX/bin/brew shellenv)" 2>/dev/null || true

# Clear the brew cache and refresh the package list (avoids formula.jws.json errors)
info "Clearing the Homebrew cache and updating..."
rm -rf ~/Library/Caches/Homebrew 2>/dev/null || true
if brew update --force --quiet 2>/dev/null; then
  ok "Homebrew updated"
else
  warn "Homebrew update failed (possibly a network problem fetching formula.jws.json)"
  info "Continuing with individual installs using HOMEBREW_NO_AUTO_UPDATE=1."
  export HOMEBREW_NO_AUTO_UPDATE=1
fi

# ── 2. Node.js ─────────────────────────────────────────────────
section "STEP 2/7 · Install Node.js"

# Download the official .pkg from a pinned version directory (dist/v<ver>/) and install it only after its SHA-256 matches SHASUMS256.txt from the same directory.
# (The latest-v22.x/ path 404s once a newer 22.x ships, and an unverified sudo installer would install a tampered package as-is.)
NODE_VERSION="22.23.4"
install_node_pkg() {
  local base="https://nodejs.org/dist/v${NODE_VERSION}"
  local pkg="node-v${NODE_VERSION}.pkg"
  local tmp
  tmp=$(mktemp -d)
  info "Downloading the official Node.js v${NODE_VERSION} .pkg..."
  curl -fsSL "${base}/${pkg}" -o "${tmp}/${pkg}"
  curl -fsSL "${base}/SHASUMS256.txt" -o "${tmp}/SHASUMS256.txt"
  local expected actual
  expected=$(grep " ${pkg}\$" "${tmp}/SHASUMS256.txt" | awk '{print $1}')
  actual=$(shasum -a 256 "${tmp}/${pkg}" | awk '{print $1}')
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -rf "$tmp"
    fail "Node.js .pkg SHA-256 mismatch (expected: ${expected:-none}, actual: ${actual}). Aborting the install."
    exit 1
  fi
  ok "SHA-256 verified"
  sudo installer -pkg "${tmp}/${pkg}" -target /
  rm -rf "$tmp"
}

if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  NODE_MINOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f2)
  # junis dependencies (@inquirer/prompts 8, glob 11) require Node 20.12 or newer
  if [ "$NODE_MAJOR" -gt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -ge 12 ]; }; then
    ok "Node.js ${NODE_VER} already installed (>= 20.12)"
  else
    warn "Node.js ${NODE_VER} is too old (20.12+ required). Upgrading..."
    install_node_pkg
    ok "Node.js $(node --version) installed"
  fi
else
  install_node_pkg
  ok "Node.js $(node --version) installed"
fi

# Check npm
if command -v npm &>/dev/null; then
  ok "npm $(npm --version)"
else
  fail "npm is not installed. Try reinstalling Node.js."
  exit 1
fi

# (Browser tools use an installed Chrome / Brave / Edge / Chromium; nothing extra is downloaded)

# ── 4. Device tool dependencies ──────────────────────────────────────
section "STEP 3/7 · Device tool dependencies"

# imagesnap (camera capture)
echo -e "\n  ${BOLD}[camera_capture]${NC} imagesnap"
if command -v imagesnap &>/dev/null; then
  ok "imagesnap already installed"
else
  info "Installing imagesnap..."
  brew install imagesnap
  ok "imagesnap installed"
fi

# CoreLocationCLI (GPS location; optional, installed as a cask)
echo -e "\n  ${BOLD}[location_get]${NC} CoreLocationCLI (optional)"
if command -v CoreLocationCLI &>/dev/null; then
  ok "CoreLocationCLI already installed"
else
  info "Installing CoreLocationCLI... (cask)"
  if brew install --cask corelocationcli 2>/dev/null; then
    ok "CoreLocationCLI installed"
    info "Gatekeeper warns on first run: click 'Open Anyway' in System Settings > Privacy & Security"
  else
    # Never sudo-copy an unverified binary. It is optional, so just explain and fall back to IP-based location.
    warn "CoreLocationCLI install failed (optional). Falling back to IP-based location."
    info "Manual install: brew install --cask corelocationcli"
  fi
fi

# ffmpeg (screen recording, multimedia; optional)
echo -e "\n  ${BOLD}[screen_record, audio]${NC} ffmpeg (optional)"
if command -v ffmpeg &>/dev/null; then
  ok "ffmpeg already installed ($(ffmpeg -version 2>&1 | head -1 | awk '{print $3}'))"
else
  info "Installing ffmpeg..."
  brew install ffmpeg
  ok "ffmpeg installed"
fi

# Check built-in tools
echo -e "\n  ${BOLD}[Built-in macOS tools]${NC}"
for cmd in screencapture pbcopy pbpaste afplay; do
  if command -v "$cmd" &>/dev/null; then
    ok "${cmd}: built in"
  else
    warn "${cmd}: not found (it ships with macOS, so its absence points to an OS problem)"
  fi
done

# ── 5. Desktop tools (Peekaboo) ────────────────────────────────
section "STEP 4/7 · Desktop tools (Peekaboo)"

MACOS_VER=$(sw_vers -productVersion 2>/dev/null || echo "0.0")
MACOS_MAJOR=$(echo "$MACOS_VER" | cut -d. -f1)

if [ "$MACOS_MAJOR" -lt 15 ]; then
  warn "Peekaboo requires macOS 15 (Sequoia) or later."
  warn "Current macOS: ${MACOS_VER}. Desktop tools will be disabled."
else
  if command -v peekaboo &>/dev/null; then
    ok "Peekaboo already installed ($(peekaboo --version 2>/dev/null || echo 'installed'))"
  else
    info "Installing Peekaboo..."
    if brew install steipete/tap/peekaboo 2>/dev/null; then
      ok "Peekaboo installed"
    else
      warn "Peekaboo install failed. Desktop tools will be disabled."
      info "Manual install: brew install steipete/tap/peekaboo"
    fi
  fi
fi

# ── 6. Notebook tools (Jupyter) ─────────────────────────────────
section "STEP 5/7 · Notebook tools (Jupyter, optional)"

if command -v jupyter &>/dev/null; then
  ok "Jupyter already installed ($(jupyter --version 2>/dev/null | head -1))"
else
  if command -v pip3 &>/dev/null; then
    info "Installing Jupyter (pip3)..."
    pip3 install --user jupyter 2>/dev/null && ok "Jupyter installed" || warn "Jupyter install failed (optional)"
  elif command -v pipx &>/dev/null; then
    info "Installing Jupyter (pipx)..."
    pipx install jupyter 2>/dev/null && ok "Jupyter installed" || warn "Jupyter install failed (optional)"
  else
    warn "No pip3/pipx. Safe to ignore if you don't use the notebook_execute tool."
    info "If needed: brew install python && pip3 install jupyter"
  fi
fi

# ── 7. Claude Code ─────────────────────────────────────────────
section "STEP 6/7 · Claude Code (AI coding agent)"

if command -v claude &>/dev/null; then
  ok "Claude Code already installed ($(claude --version 2>/dev/null || echo 'installed'))"
else
  info "Installing Claude Code... (native install; Node.js not required)"
  # Anthropic's official install command, unchanged (https://claude.ai/install.sh)
  if curl -fsSL https://claude.ai/install.sh | bash 2>/dev/null; then
    # Refresh PATH after install (the script installs into ~/.local/bin)
    export PATH="$HOME/.local/bin:$HOME/.claude/local/bin:$PATH"
    ok "Claude Code installed"
  else
    warn "Claude Code automatic install failed."
    info "Manual install: curl -fsSL https://claude.ai/install.sh | bash"
    info "Or: brew install --cask claude-code"
  fi
fi

# Register the junis MCP server with Claude Code via claude's own command (Claude Code does not read MCP servers from settings.json)
if command -v claude &>/dev/null; then
  echo ""
  echo -e "  ${BOLD}Register the junis MCP server with Claude Code?${NC}"
  echo -e "  (claude mcp add --scope user junis-device -- npx -y junis --stdio)"
  read -rp "  [Y/n] > " REGISTER_MCP
  REGISTER_MCP="${REGISTER_MCP:-Y}"

  if [[ "$REGISTER_MCP" =~ ^[Yy]$ ]]; then
    if claude mcp get junis-device &>/dev/null; then
      skip "junis MCP already registered"
    elif claude mcp add --scope user junis-device -- npx -y junis --stdio; then
      ok "junis MCP registered (check with claude mcp list)"
    else
      warn "Registration failed. Register manually: claude mcp add --scope user junis-device -- npx -y junis --stdio"
    fi
  fi
else
  info "claude command not found; skipping MCP registration. After installing it: claude mcp add --scope user junis-device -- npx -y junis --stdio"
fi

# ── 8. macOS permissions ────────────────────────────────────────
section "STEP 7/7 · macOS permissions"

echo ""
echo -e "  ${BOLD}Grant the following permissions to your terminal app.${NC}"
echo -e "  (current terminal: ${BOLD}${TERM_PROGRAM:-Terminal}${NC})"
echo ""

# Map TERM_PROGRAM to the terminal app name
case "${TERM_PROGRAM:-}" in
  ghostty)       TERM_NAME="Ghostty" ;;
  Apple_Terminal) TERM_NAME="Terminal" ;;
  iTerm.app)     TERM_NAME="iTerm2" ;;
  WarpTerminal)  TERM_NAME="Warp" ;;
  vscode)        TERM_NAME="Visual Studio Code" ;;
  *)             TERM_NAME="${TERM_PROGRAM:-Terminal}" ;;
esac

echo -e "  ${BOLD}1) Accessibility${NC}"
echo -e "     → add '${TERM_NAME}' to the list and turn it ON"
echo -e "     → required for desktop_click, desktop_type, desktop_hotkey and others"
echo ""
echo -e "  ${BOLD}2) Screen Recording${NC}"
echo -e "     → add '${TERM_NAME}' to the list and turn it ON"
echo -e "     → required for desktop_screenshot, desktop_see, screen_capture"
echo ""
echo -e "  ${BOLD}3) Camera${NC}"
echo -e "     → camera_capture shows a dialog on first run; click 'Allow'"
echo ""

# Trigger the native Accessibility prompt (adds the app to the System Settings list automatically)
echo -e "  ${CYAN}Triggering the system permission dialogs...${NC}"
echo ""

# Accessibility trigger
swift -e '
import ApplicationServices
let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
let trusted = AXIsProcessTrustedWithOptions(opts)
if trusted { print("  [ok] Accessibility: already allowed") }
else { print("  [warn] Accessibility: allow it in System Settings") }
' 2>/dev/null || true

# Screen Recording trigger
swift -e '
import CoreGraphics
let hasAccess = CGPreflightScreenCaptureAccess()
if hasAccess { print("  [ok] Screen Recording: already allowed") }
else {
  CGRequestScreenCaptureAccess()
  print("  [warn] Screen Recording: allow it in System Settings")
}
' 2>/dev/null || true

echo ""

# Ask whether to open the System Settings panes
echo -e "  ${BOLD}Open the System Settings panes?${NC}"
read -rp "  [Y/n] > " OPEN_SETTINGS
OPEN_SETTINGS="${OPEN_SETTINGS:-Y}"

if [[ "$OPEN_SETTINGS" =~ ^[Yy]$ ]]; then
  echo ""
  info "Opening Accessibility settings..."
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  echo -e "  → Add '${TERM_NAME}' and turn it ON."
  read -rp "  Press Enter when done... "

  info "Opening Screen Recording settings..."
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  echo -e "  → Add '${TERM_NAME}' and turn it ON."
  read -rp "  Press Enter when done... "

  ok "Permissions configured"
fi

# ── Summary ──────────────────────────────────────────────────
section "Setup complete"

echo ""
echo -e "  ${BOLD}Installed tools:${NC}"
echo ""

check_tool() {
  local name="$1"
  local cmd="$2"
  if command -v "$cmd" &>/dev/null; then
    echo -e "    ${GREEN}[ok]${NC} ${name}"
  else
    echo -e "    ${RED}[missing]${NC} ${name}: ${cmd} not found"
  fi
}

echo -e "  ${BOLD}[Required]${NC}"
check_tool "Node.js         " "node"
check_tool "npm             " "npm"
check_tool "Homebrew        " "brew"
check_tool "Claude Code     " "claude"

echo ""
echo -e "  ${BOLD}[Browser tools]${NC}"
# Uses an installed browser (Chrome / Brave / Edge / Chromium)
if [ -d "/Applications/Google Chrome.app" ] || [ -d "/Applications/Brave Browser.app" ] || [ -d "/Applications/Microsoft Edge.app" ] || [ -d "/Applications/Chromium.app" ]; then
  echo -e "    ${GREEN}[ok]${NC} Chrome / Brave / Edge / Chromium found"
else
  echo -e "    ${YELLOW}[skip]${NC} Install Chrome, Brave, Edge or Chromium for the browser_* tools to work"
fi

echo ""
echo -e "  ${BOLD}[Device tools]${NC}"
check_tool "imagesnap       (camera)   " "imagesnap"
check_tool "screencapture   (screen)   " "screencapture"
check_tool "pbcopy/pbpaste  (clipboard)" "pbcopy"
check_tool "afplay          (audio)    " "afplay"
check_tool "CoreLocationCLI (GPS)      " "CoreLocationCLI"
check_tool "ffmpeg          (video)    " "ffmpeg"

echo ""
echo -e "  ${BOLD}[Desktop tools]${NC}"
check_tool "Peekaboo        (macOS GUI)" "peekaboo"

echo ""
echo -e "  ${BOLD}[Notebook tools]${NC}"
check_tool "Jupyter         (notebook) " "jupyter"

echo ""
echo -e "  ${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo ""
echo -e "    ${GREEN}npx junis${NC}                  cloud mode (OAuth sign-in)"
echo -e "    ${GREEN}npx junis --local${NC}           local-only mode"
echo -e "    ${GREEN}npx junis --stdio${NC}           Claude Code/Desktop integration"
echo ""
echo -e "  ${BOLD}Claude Code MCP registration (manual):${NC}"
echo ""
echo -e "    ${GREEN}claude mcp add --scope user junis-device -- npx -y junis --stdio${NC}"
echo ""
echo -e "  ${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
