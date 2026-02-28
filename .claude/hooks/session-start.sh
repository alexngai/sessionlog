#!/bin/bash
set -euo pipefail

# Only run in remote (ccweb) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# --- Configuration ---
# Branch prefixes allowed to push via direct GitHub access.
# Space-separated. Edit this to allow additional prefixes.
ALLOWED_PUSH_PREFIXES="entire/ claude/"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# --- 1. Install npm dependencies ---
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "[setup-env] Installing npm dependencies" >&2
  cd "$PROJECT_DIR" && npm install 2>&1 >&2
else
  echo "[setup-env] node_modules already present, skipping install" >&2
fi

# --- 2. Build TypeScript project ---
if [ ! -d "$PROJECT_DIR/dist" ]; then
  echo "[setup-env] Building TypeScript project" >&2
  cd "$PROJECT_DIR" && npm run build 2>&1 >&2
else
  echo "[setup-env] dist/ already present, skipping build" >&2
fi

# --- 3. Link entire CLI globally ---
if ! command -v entire >/dev/null 2>&1; then
  echo "[setup-env] Linking entire-cli globally" >&2
  cd "$PROJECT_DIR" && npm link 2>&1 >&2
  echo "[setup-env] entire CLI linked to PATH" >&2
else
  echo "[setup-env] entire CLI already on PATH" >&2
fi

# --- 4. Enable entire for Claude Code ---
if ! entire status 2>/dev/null | grep -q "Enabled"; then
  echo "[setup-env] Running entire enable --agent claude-code" >&2
  cd "$PROJECT_DIR" && entire enable --agent claude-code 2>&1 >&2
  echo "[setup-env] entire enabled" >&2
else
  echo "[setup-env] entire already enabled" >&2
fi

# --- 5. Configure direct GitHub push access (bypass proxy) ---
if [ -n "${GITHUB_TOKEN:-}" ]; then
  PROXY_URL=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null | sed 's|\(.*\)/git/.*|\1/git/|')
  if [ -n "$PROXY_URL" ]; then
    git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".pushInsteadOf "$PROXY_URL"
    echo "[setup-env] Configured direct GitHub push access" >&2
  fi
fi

# --- 6. Install pre-push filter ---
# Only allow pushing branches matching ALLOWED_PUSH_PREFIXES + current branch.
HOOKS_DIR=$(git -C "$PROJECT_DIR" rev-parse --git-path hooks 2>/dev/null)
if [ -n "$HOOKS_DIR" ] && [ ! -f "$HOOKS_DIR/pre-push" ]; then
  mkdir -p "$HOOKS_DIR"
  cat > "$HOOKS_DIR/pre-push" << HOOK
#!/bin/sh
ALLOWED_PREFIXES="$ALLOWED_PUSH_PREFIXES"
CURRENT_BRANCH=\$(git symbolic-ref --short HEAD 2>/dev/null)

while read local_ref local_sha remote_ref remote_sha; do
  branch="\${remote_ref#refs/heads/}"
  # Always allow pushing the current branch
  if [ "\$branch" = "\$CURRENT_BRANCH" ]; then
    continue
  fi
  allowed=false
  for prefix in \$ALLOWED_PREFIXES; do
    case "\$branch" in
      "\$prefix"*) allowed=true; break ;;
    esac
  done
  if [ "\$allowed" = false ]; then
    echo "[pre-push] blocked: \$branch (allowed: \$ALLOWED_PREFIXES + current branch)" >&2
    exit 1
  fi
done
HOOK
  chmod +x "$HOOKS_DIR/pre-push"
  echo "[setup-env] Installed pre-push filter (allowed: $ALLOWED_PUSH_PREFIXES)" >&2
fi

echo "[setup-env] Setup complete" >&2
