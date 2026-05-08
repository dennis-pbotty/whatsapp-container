#!/usr/bin/env bash
# setup.sh — install, configure, and pair WhatsApp accounts.
# Safe to re-run at any time. Existing accounts and data are never touched.
set -euo pipefail

RESET='\033[0m'; BOLD='\033[1m'; DIM='\033[2m'
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

step()   { echo -e "  ${CYAN}▸${RESET}  $1"; }
ok()     { echo -e "  ${GREEN}✓${RESET}  $1"; }
warn()   { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
die()    { echo -e "  ${RED}✗${RESET}  $1" >&2; exit 1; }
header() {
  echo ""
  echo -e "${BOLD}$1${RESET}"
  printf "${DIM}"; printf '─%.0s' {1..54}; printf "${RESET}\n"
}

# ── Machine IP ────────────────────────────────────────────────────────────────
get_ip() {
  if command -v ip &>/dev/null; then
    ip route get 1.1.1.1 2>/dev/null \
      | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'
    return
  fi
  ipconfig getifaddr en0 2>/dev/null && return
  ipconfig getifaddr en1 2>/dev/null && return
  hostname -I 2>/dev/null | awk '{print $1}' && return
  echo "127.0.0.1"
}
MACHINE_IP="$(get_ip)"
OS="$(uname -s)"

# ── Docker ────────────────────────────────────────────────────────────────────
header "Checking Docker"

if ! command -v docker &>/dev/null; then
  warn "Docker not found — installing..."
  if [[ "$OS" == "Linux" ]]; then
    curl -fsSL https://get.docker.com | sh
    if ! groups "$USER" 2>/dev/null | grep -q '\bdocker\b'; then
      sudo usermod -aG docker "$USER"
      warn "Added $USER to the docker group. Applying without logout..."
      exec sg docker -- bash "$0" "$@"
    fi
  elif [[ "$OS" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      brew install --cask docker
      warn "Docker Desktop installed. Open it from Applications, then re-run this script."
      open -a Docker 2>/dev/null || true
      exit 0
    else
      echo -e "\n  Get Docker Desktop: ${CYAN}https://www.docker.com/products/docker-desktop${RESET}"
      exit 1
    fi
  else
    die "Unsupported OS. Install Docker: https://docs.docker.com/get-docker/"
  fi
fi

DOCKER="docker"
if ! docker info &>/dev/null 2>&1; then
  if [[ "$OS" == "Darwin" ]]; then
    open -a Docker 2>/dev/null || true
    die "Docker is not running. Start Docker Desktop and re-run this script."
  fi

  # On Linux, Docker may be running but the current user may not have access to
  # /var/run/docker.sock yet. Prefer sudo when available so setup can continue
  # immediately instead of failing with a misleading "not running" message.
  if command -v sudo &>/dev/null && sudo -n docker info &>/dev/null 2>&1; then
    DOCKER="sudo docker"
    warn "Docker is running, but this user cannot access it directly — using sudo docker."
  else
    die "Docker is not reachable. Start Docker, or add $USER to the docker group and re-login."
  fi
fi
ok "Docker $($DOCKER --version | awk '{print $3}' | tr -d ',')"

if $DOCKER compose version &>/dev/null 2>&1; then
  DC="$DOCKER compose"
elif command -v docker-compose &>/dev/null; then
  DC="docker-compose"
else
  die "docker compose not found. Install: https://docs.docker.com/compose/install/"
fi
ok "Compose ($DC)"

# ── Admin password ────────────────────────────────────────────────────────────
header "Configuration"

if [[ ! -f .env ]]; then
  echo -e "  ${DIM}Choose an admin password for the dashboard.${RESET}"
  echo -e "  ${DIM}You'll use it to create and revoke API tokens.${RESET}"
  echo ""
  while true; do
    printf "  Admin password: ";  read -rs ADMIN_SECRET; echo ""
    [[ -z "$ADMIN_SECRET" ]] && { warn "Password cannot be empty."; continue; }
    printf "  Confirm:        ";  read -rs CONFIRM;       echo ""
    [[ "$ADMIN_SECRET" != "$CONFIRM" ]] && { warn "Passwords don't match — try again."; continue; }
    break
  done
  printf 'ADMIN_SECRET=%s\n' "$ADMIN_SECRET" > .env
  ok ".env created"
  echo ""
else
  ok ".env already present (password unchanged)"
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
# Convert a human label into a safe slug for container/directory names
slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//;s/-*$//'
}

# Find the next port not already in .accounts (starts at 8792)
next_port() {
  local p=8792
  while [[ -f .accounts ]] && grep -q "|${p}$" .accounts 2>/dev/null; do
    (( p++ ))
  done
  echo "$p"
}

accounts_exist() {
  [[ -f .accounts ]] && grep -qv '^[[:space:]]*#' .accounts 2>/dev/null
}

# ── Compose generator ─────────────────────────────────────────────────────────
# Outputs YAML for one service block; variables are expanded intentionally.
service_yaml() {
  local name="$1" label="$2" port="$3"
  cat <<EOF

  wa-${name}:
    build:
      context: ./wa-agents-service
    container_name: wa-${name}
    restart: unless-stopped
    ports:
      - "${port}:${port}"
    volumes:
      - ./data/${name}:/data
    env_file: .env
    environment:
      - PORT=${port}
      - "SERVICE_LABEL=${label}"
      - WACLI_STORE_DIR=/data/wacli
      - WACLI_DB=/data/wacli/wacli.db
      - WACLI_SESSION_DB=/data/wacli/session.db
      - DB_PATH=/data/wa-bot.db
EOF
}

generate_compose() {
  step "Generating docker-compose.yml..."
  {
    printf '# Auto-generated by setup.sh — do not edit manually.\n'
    printf '# Run ./setup.sh to add accounts or reconfigure.\n'
    printf 'services:\n'
    while IFS='|' read -r name label port; do
      [[ "$name" =~ ^[[:space:]]*# || -z "${name// }" ]] && continue
      service_yaml "$name" "$label" "$port"
    done < .accounts
  } > docker-compose.yml
  local count
  count=$(grep -c 'container_name:' docker-compose.yml || true)
  ok "docker-compose.yml written (${count} service(s))"
}

# ── Migration: old layout → new layout ───────────────────────────────────────
migrate_if_needed() {
  # Only relevant when .accounts doesn't exist but old data directories do
  accounts_exist && return 0
  [[ -d ./wa-agents-service/data ]] || [[ -d ./wa-read-service/data ]] || return 0

  header "Migrating existing data"
  echo "  Found data from a previous installation:"
  [[ -d ./wa-agents-service/data ]] && \
    echo -e "    ${DIM}wa-agents-service/data${RESET}  →  data/agents/"
  [[ -d ./wa-read-service/data  ]] && \
    echo -e "    ${DIM}wa-read-service/data${RESET}    →  data/personal/"
  echo ""
  echo -e "  Backups will be kept at ${DIM}data/agents.backup/${RESET} and ${DIM}data/personal.backup/${RESET}"
  echo -e "  ${DIM}docker-compose.yml will be backed up as docker-compose.yml.backup${RESET}"
  echo ""
  printf "  Proceed with migration? [y/N]: "; read -r confirm; echo ""
  [[ "$confirm" != "y" && "$confirm" != "Y" ]] && { warn "Migration skipped."; return 0; }

  # Stop existing containers before moving their mounted directories
  if [[ -f docker-compose.yml ]]; then
    step "Stopping existing containers..."
    $DC down 2>/dev/null || true
    cp docker-compose.yml docker-compose.yml.backup
    ok "Old docker-compose.yml backed up"
  fi

  mkdir -p ./data

  if [[ -d ./wa-agents-service/data ]]; then
    step "Backing up agents data..."
    cp -r ./wa-agents-service/data ./data/agents.backup
    step "Moving agents data → ./data/agents/ ..."
    mv ./wa-agents-service/data ./data/agents
    printf 'agents|Agents Line|8792\n' >> .accounts
    ok "Agents Line migrated  (backup: ./data/agents.backup/)"
  fi

  if [[ -d ./wa-read-service/data ]]; then
    step "Backing up personal data..."
    cp -r ./wa-read-service/data ./data/personal.backup
    step "Moving personal data → ./data/personal/ ..."
    mv ./wa-read-service/data ./data/personal
    printf 'personal|Personal Line|8793\n' >> .accounts
    ok "Personal Line migrated  (backup: ./data/personal.backup/)"
  fi

  echo ""
  echo -e "  ${DIM}To restore if something goes wrong:${RESET}"
  echo -e "  ${DIM}  mv data/agents.backup   wa-agents-service/data${RESET}"
  echo -e "  ${DIM}  mv data/personal.backup wa-read-service/data${RESET}"
  echo -e "  ${DIM}  cp docker-compose.yml.backup docker-compose.yml${RESET}"
  echo -e "  ${DIM}  $DC up -d${RESET}"
  echo ""
}

# ── Add one account (prompts, appends to .accounts) ──────────────────────────
add_account() {
  local suggested_port
  suggested_port="$(next_port)"

  echo ""
  printf "  Account label (e.g. \"My WhatsApp\"): "; read -r label
  [[ -z "$label" ]] && { warn "Label cannot be empty."; return 1; }

  local name
  name="$(slugify "$label")"
  # Avoid duplicate slugs
  if [[ -f .accounts ]] && grep -q "^${name}|" .accounts 2>/dev/null; then
    name="${name}-$(date +%s | tail -c 4)"
  fi

  printf "  Port [${suggested_port}]: "; read -r port
  port="${port:-$suggested_port}"
  if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then
    warn "Invalid port — using $suggested_port."; port="$suggested_port"
  fi

  printf '%s|%s|%s\n' "$name" "$label" "$port" >> .accounts
  mkdir -p "./data/${name}"
  ok "\"${label}\" added  (port ${port},  data → ./data/${name}/)"
}

# ── Account management ────────────────────────────────────────────────────────
header "Accounts"

if accounts_exist; then
  # Re-run: show what's already configured, offer to add more
  echo -e "  ${DIM}Existing accounts (data and sessions will not be changed):${RESET}"
  echo ""
  while IFS='|' read -r name label port; do
    [[ "$name" =~ ^[[:space:]]*# || -z "${name// }" ]] && continue
    echo -e "    ${GREEN}✓${RESET}  $label  →  http://$MACHINE_IP:$port"
  done < .accounts
  echo ""
  printf "  Add another account? [y/N]: "; read -r add_more; echo ""
  if [[ "$add_more" == "y" || "$add_more" == "Y" ]]; then
    add_account
    while true; do
      printf "\n  Add another? [y/N]: "; read -r more; echo ""
      [[ "$more" != "y" && "$more" != "Y" ]] && break
      add_account
    done
  fi
else
  # First run: check for old data to migrate, then add accounts
  migrate_if_needed

  if ! accounts_exist; then
    # Fresh install — set up first account
    echo -e "  ${DIM}Set up your first WhatsApp account.${RESET}"
    add_account
  fi

  # Offer additional accounts
  while true; do
    printf "\n  Add another account? [y/N]: "; read -r more; echo ""
    [[ "$more" != "y" && "$more" != "Y" ]] && break
    add_account
  done
fi

# ── Generate compose + start ──────────────────────────────────────────────────
header "Starting services"

generate_compose
echo ""
step "Starting containers..."
$DC up -d --build 2>&1 | grep -E 'Built|Started|Recreated|Running|Error|error' || true
echo ""

# ── Wait for health ────────────────────────────────────────────────────────────
while IFS='|' read -r name label port; do
  [[ "$name" =~ ^[[:space:]]*# || -z "${name// }" ]] && continue
  tries=0
  printf "  Waiting for %-24s" "${label}..."
  until curl -sf "http://localhost:$port/api/health" &>/dev/null; do
    printf "."; sleep 1; (( tries++ ))
    if (( tries > 50 )); then
      echo -e " ${RED}timeout${RESET}"
      warn "Port $port didn't respond. Check: $DC logs wa-${name}"
      break
    fi
  done
  (( tries <= 50 )) && echo -e " ${GREEN}ready${RESET}"
done < .accounts

# ── Pairing ───────────────────────────────────────────────────────────────────
is_authed() { curl -sf "http://localhost:$1/api/status" 2>/dev/null | grep -q '"connected":true'; }

pair_service() {
  local name="$1" label="$2" port="$3"
  local url="http://$MACHINE_IP:$port"

  echo ""
  echo -e "  ${YELLOW}${BOLD}${label} needs pairing.${RESET}"
  echo -e "  ${DIM}On your phone: WhatsApp → Settings → Linked Devices → Link a Device${RESET}"
  echo ""
  echo "    1)  QR code in this terminal  (recommended)"
  echo "    2)  Web dashboard  —  $url"
  echo ""
  printf "  Choice [1/2]: "; read -r choice; echo ""

  if [[ "${choice}" == "2" ]]; then
    step "Open in your browser:  ${BOLD}$url${RESET}"
    [[ "$OS" == "Darwin" ]] && open "$url" 2>/dev/null \
      || xdg-open "$url" 2>/dev/null || true
    echo -e "  ${DIM}Connection tab → Show QR → scan with WhatsApp.${RESET}"
    echo ""; printf "  Press Enter once paired... "; read -r
  else
    $DOCKER exec -it "wa-${name}" wacli auth || true
  fi

  local tries=0
  printf "  Verifying..."
  until is_authed "$port"; do
    printf "."; sleep 2; (( tries++ ))
    if (( tries > 15 )); then
      echo ""; warn "Could not confirm pairing automatically."
      warn "Check the Connection tab at $url"
      return 0
    fi
  done
  echo -e " ${GREEN}paired!${RESET}"
}

header "WhatsApp pairing"

while IFS='|' read -r name label port; do
  [[ "$name" =~ ^[[:space:]]*# || -z "${name// }" ]] && continue
  if is_authed "$port"; then
    ok "$label — already paired, skipping"
  else
    pair_service "$name" "$label" "$port"
  fi
done < .accounts

# ── Summary ───────────────────────────────────────────────────────────────────
ADMIN_SECRET="$(grep '^ADMIN_SECRET=' .env | cut -d= -f2-)"

echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  All done!${RESET}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
while IFS='|' read -r name label port; do
  [[ "$name" =~ ^[[:space:]]*# || -z "${name// }" ]] && continue
  echo -e "  ${label}  →  ${CYAN}${BOLD}http://$MACHINE_IP:$port${RESET}"
done < .accounts
echo ""
echo -e "  Admin secret  →  ${BOLD}${ADMIN_SECRET}${RESET}"
echo ""
echo -e "  ${DIM}Add accounts later:  ./setup.sh${RESET}"
echo -e "  ${DIM}Stop all:            $DC down${RESET}"
echo -e "  ${DIM}Start all:           $DC up -d${RESET}"
echo -e "  ${DIM}Logs:                $DC logs -f${RESET}"
echo ""
