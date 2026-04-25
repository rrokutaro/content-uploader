#!/bin/bash
# ============================================================
# start-uploader.sh
#
# Bootstraps and launches uploader-server.js.
# Run once; re-run it to start fresh or after a crash.
#
# Usage:
#   bash start-uploader.sh [options]
#
# Options (all optional — override env vars or on-start.env):
#   --configs   <a.json,b.json>       Configs to process (REQUIRED)
#   --min-gap   <ms>                  Min ms between uploads (default: from config)
#   --window    <HH:MM-HH:MM>         UTC upload window (e.g. 13:00-23:00)
#   --log-file  <path>                Log file path
#   --dry-run                         No uploads or deletes
#   --refetch-interval <seconds>      How often to re-fetch configs/secrets (default: 600)
#   --loop                            Restart the node process after each run
# ============================================================
set -e

# ── local env file ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/on-start.env"

if [[ -f "$ENV_FILE" ]]; then
    echo "📄 Loading on-start.env..."
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ -z "$line" || "$line" == \#* ]] && continue
        [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && export "$line"
    done < "$ENV_FILE"
    echo "✅ Env loaded."
fi

# ── defaults (can be overridden by env or CLI) ──────────────────────────────
UPLOADER_CONFIGS="${UPLOADER_CONFIGS:-}"
UPLOADER_MIN_GAP="${UPLOADER_MIN_GAP:-}"            # ms; leave empty → use config value
UPLOADER_WINDOW="${UPLOADER_WINDOW:-}"              # e.g. "13:00-23:00"
UPLOADER_LOG_FILE="${UPLOADER_LOG_FILE:-${SCRIPT_DIR}/uploader-server.log}"
UPLOADER_DRY_RUN="${UPLOADER_DRY_RUN:-false}"
UPLOADER_REFETCH_INTERVAL="${UPLOADER_REFETCH_INTERVAL:-600}"
UPLOADER_LOOP="${UPLOADER_LOOP:-false}"

# ── parse CLI args (override env) ──────────────────────────────────────────
EXTRA_NODE_ARGS=()
LOOP=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --configs)            UPLOADER_CONFIGS="$2";          shift 2 ;;
        --min-gap)            UPLOADER_MIN_GAP="$2";          shift 2 ;;
        --window)             UPLOADER_WINDOW="$2";           shift 2 ;;
        --log-file)           UPLOADER_LOG_FILE="$2";         shift 2 ;;
        --refetch-interval)   UPLOADER_REFETCH_INTERVAL="$2"; shift 2 ;;
        --dry-run)            UPLOADER_DRY_RUN="true";        shift   ;;
        --loop)               LOOP=true;                      shift   ;;
        *)                    shift ;;
    esac
done

[[ "${UPLOADER_LOOP}" == "true" ]] && LOOP=true

# ── validate ────────────────────────────────────────────────────────────────
if [[ -z "$UPLOADER_CONFIGS" ]]; then
    echo "❌  --configs is required  (or set UPLOADER_CONFIGS env var)"
    echo "    e.g.:  bash start-uploader.sh --configs config1.json,config2.json"
    exit 1
fi

# ── root / sudo detection ───────────────────────────────────────────────────
if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
else
    SUDO="sudo"
fi

cd "$SCRIPT_DIR"

# ── 1. system deps ──────────────────────────────────────────────────────────
echo "[1/4] Checking system dependencies..."
$SUDO apt-get update -qq

# python3 + gdown
if ! command -v python3 &>/dev/null; then
    $SUDO apt-get install -y -qq python3 python3-pip
fi

if ! pip3 show gdown &>/dev/null 2>&1; then
    echo " -> Installing gdown..."
    pip3 install --upgrade -q gdown --break-system-packages 2>/dev/null \
        || pip3 install --upgrade -q gdown
fi

# unzip
if ! command -v unzip &>/dev/null; then
    $SUDO apt-get install -y -qq unzip
fi

# yt-dlp (always upgrade — updates frequently for YT compatibility)
echo " -> Updating yt-dlp..."
pip3 install --upgrade -q "yt-dlp[default]" --break-system-packages 2>/dev/null \
    || pip3 install --upgrade -q "yt-dlp[default]"

echo " -> ✅ System deps OK"

# ── 2. Node.js ──────────────────────────────────────────────────────────────
echo "[2/4] Checking Node.js..."

# Try system Node first (works on Colab, local machines, etc)
if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    echo " -> Found system Node: $NODE_VER"
else
    # Fallback: install Node 20 via apt
    echo " -> Installing Node 20 via apt..."
    $SUDO apt-get install -y -qq nodejs npm
fi

echo " -> Node: $(node -v)  npm: $(npm -v)"

# ── 3. npm packages ─────────────────────────────────────────────────────────
echo "[3/4] Installing npm dependencies..."

REQUIRED_PKGS=(googleapis)
INSTALL_NEEDED=false

for pkg in "${REQUIRED_PKGS[@]}"; do
    if [[ ! -d "node_modules/$pkg" ]]; then
        INSTALL_NEEDED=true
        break
    fi
done

if [[ "$INSTALL_NEEDED" == "true" ]]; then
    if [[ -f "package.json" ]]; then
        npm install
    else
        npm install --save googleapis
    fi
fi

echo " -> ✅ npm deps ready"

# ── 4. initial asset fetch ──────────────────────────────────────────────────
echo "[4/4] Fetching assets from GDrive (if needed)..."

_gdrive_fetch() {
    local file_id="$1" dest="$2"
    [[ -z "$file_id" ]] && return
    if [[ -d "$dest" && -n "$(ls -A "$dest" 2>/dev/null)" ]]; then
        echo " -> $dest already populated, skipping."
        return
    fi
    local tmpzip="/tmp/fetch_${RANDOM}.zip"
    echo " -> Fetching $dest..."
    gdown "https://drive.google.com/uc?id=${file_id}" -O "$tmpzip" --quiet --fuzzy \
        && { mkdir -p "$dest"; unzip -q "$tmpzip" -d "$dest"; rm -f "$tmpzip"; echo " -> ✅ $dest fetched"; } \
        || echo " -> ⚠️  Failed to fetch $dest (skipping)"
}

[[ "${DISABLE_SERVER_CONFIGS_FETCH}" != "true" ]] && _gdrive_fetch "${GDRIVE_SERVER_CONFIGS_ID}" "assets/server-configs"
[[ "${DISABLE_CLIENT_SECRETS_FETCH}" != "true" ]] && _gdrive_fetch "${GDRIVE_CLIENT_SECRETS_ID}"  "assets/client-secrets"
[[ "${DISABLE_CLIENT_TOKENS_FETCH}"  != "true" ]] && _gdrive_fetch "${GDRIVE_CLIENT_TOKENS_ID}"   "assets/client-tokens"

echo "================================"
echo " UPLOADER SERVER READY"
echo " Configs:           $UPLOADER_CONFIGS"
echo " Upload window:     ${UPLOADER_WINDOW:-any time}"
echo " Min gap:           ${UPLOADER_MIN_GAP:-from config}"
echo " Dry run:           $UPLOADER_DRY_RUN"
echo " Log file:          $UPLOADER_LOG_FILE"
echo " Refetch interval:  ${UPLOADER_REFETCH_INTERVAL}s"
echo " Loop mode:         $LOOP"
echo "================================"

# ── build node command ───────────────────────────────────────────────────────
NODE_ARGS=(
    "uploader-server.js"
    "--configs"          "$UPLOADER_CONFIGS"
    "--log-file"         "$UPLOADER_LOG_FILE"
    "--refetch-interval" "$UPLOADER_REFETCH_INTERVAL"
)

[[ -n "$UPLOADER_MIN_GAP"  ]] && NODE_ARGS+=(--min-gap "$UPLOADER_MIN_GAP")
[[ -n "$UPLOADER_WINDOW"   ]] && NODE_ARGS+=(--window  "$UPLOADER_WINDOW")
[[ "$UPLOADER_DRY_RUN" == "true" ]] && NODE_ARGS+=(--dry-run)

# ── launch ───────────────────────────────────────────────────────────────────
if [[ "$LOOP" == "true" ]]; then
    echo "🔁 Loop mode enabled — will restart after each run."
    trap 'echo "🛑 Stopping loop."; exit 0' SIGINT SIGTERM
    while true; do
        node "${NODE_ARGS[@]}" || echo "⚠️  Node exited with error; restarting in 30s..."
        sleep 30
    done
else
    node "${NODE_ARGS[@]}"
fi