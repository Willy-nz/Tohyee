#!/usr/bin/env bash
# Installs the Tohyee camera post box on a fresh Ubuntu server (decisions 1226-1233).
#
#   curl -fsSL https://raw.githubusercontent.com/Willy-nz/Tohyee/v<version>/postbox/install.sh | sudo bash -s -- --version <version>
#
# What it does:
#   1. Installs Docker from Ubuntu's own packages, if it isn't there.
#   2. Works out this server's public IPv4 address (or use --address).
#   3. Writes /opt/tohyee-postbox/compose.yaml and .env, and starts the post box
#      (image ghcr.io/willy-nz/tohyee-postbox:<version>).
#   4. Opens its ports in the server's firewall (ufw), if ufw is on.
#   5. Shows a pairing code to paste into Tohyee (Farm > Security > Post box).
#
# Running it again is safe: the queue, the certificate and the pairing are kept
# in the Docker volume, and a new pairing code is shown.
#
# Options:
#   --version V     the post box version (default: latest)
#   --address IP    this server's public IPv4 address, if it can't be worked out
#   --ftp-port N    the port cameras use (default 21)
#   --api-port N    the port Tohyee collects from (default 8443)
#   --image NAME    another image, e.g. one you built yourself
set -euo pipefail

VERSION="latest"
ADDRESS=""
FTP_PORT="21"
API_PORT="8443"
IMAGE="ghcr.io/willy-nz/tohyee-postbox"
DIR="/opt/tohyee-postbox"
PASSIVE="50000-50019"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --address) ADDRESS="${2:?--address needs a value}"; shift 2 ;;
    --ftp-port) FTP_PORT="${2:?--ftp-port needs a value}"; shift 2 ;;
    --api-port) API_PORT="${2:?--api-port needs a value}"; shift 2 ;;
    --image) IMAGE="${2:?--image needs a value}"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done

[[ "$VERSION" =~ ^(latest|[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?)$ ]] || die "--version must be like 1.2.3"
[[ "$FTP_PORT" =~ ^[0-9]{1,5}$ && "$API_PORT" =~ ^[0-9]{1,5}$ ]] || die "ports must be numbers"
[[ "$IMAGE" =~ ^[a-z0-9./_:-]+$ ]] || die "--image isn't an image name"
[ "$(id -u)" -eq 0 ] || die "run it with sudo (it installs Docker and opens ports)"

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || echo "Note: this was written for Ubuntu; this server is ${PRETTY_NAME:-unknown}. Carrying on."
fi

is_ipv4() { [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] && for part in "${BASH_REMATCH[@]:1}"; do [ "$part" -le 255 ] || return 1; done; }
is_private() { [[ "$1" =~ ^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]; }

say "1/5 Docker"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io docker-compose-v2
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || { apt-get update -q; DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker-compose-v2; }
echo "Docker is ready."

say "2/5 This server's public address"
if [ -z "$ADDRESS" ]; then
  ADDRESS="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  if [ -z "$ADDRESS" ] || is_private "$ADDRESS"; then
    # Behind the provider's own network (some clouds): ask a public "what's my address" service.
    ADDRESS="$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  fi
fi
is_ipv4 "$ADDRESS" || die "couldn't work out this server's public IPv4 address. Run it again with --address <the address your provider shows>."
is_private "$ADDRESS" && die "$ADDRESS is a private address. Cameras need a public one: run it again with --address <public IPv4>."
echo "Cameras and Tohyee will reach this server at $ADDRESS."

say "3/5 The post box"
install -d -m 0750 "$DIR"
cat > "$DIR/.env" <<ENV
POSTBOX_PUBLIC_ADDRESS=$ADDRESS
POSTBOX_FTP_PUBLIC_PORT=$FTP_PORT
POSTBOX_API_PUBLIC_PORT=$API_PORT
ENV
cat > "$DIR/compose.yaml" <<COMPOSE
# Written by Tohyee's postbox/install.sh. Run it again to change settings.
services:
  postbox:
    image: $IMAGE:$VERSION
    container_name: tohyee-postbox
    restart: unless-stopped
    environment:
      POSTBOX_PUBLIC_ADDRESS: \${POSTBOX_PUBLIC_ADDRESS}
      POSTBOX_FTP_PUBLIC_PORT: \${POSTBOX_FTP_PUBLIC_PORT}
      POSTBOX_API_PUBLIC_PORT: \${POSTBOX_API_PUBLIC_PORT}
      POSTBOX_PASSIVE_PORTS: $PASSIVE
    ports:
      - "\${POSTBOX_FTP_PUBLIC_PORT}:2121"
      - "$PASSIVE:$PASSIVE"
      - "\${POSTBOX_API_PUBLIC_PORT}:8443"
    volumes:
      - postbox-data:/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
volumes:
  postbox-data:
COMPOSE
cd "$DIR"
docker compose pull || die "couldn't download $IMAGE:$VERSION. If that version has no post box image yet, see 'Building it yourself' in Tohyee's docs/FARM-SECURITY.md."
docker compose up -d

say "4/5 Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$FTP_PORT/tcp" comment "Tohyee post box: cameras" >/dev/null
  ufw allow "${PASSIVE/-/:}/tcp" comment "Tohyee post box: camera files" >/dev/null
  ufw allow "$API_PORT/tcp" comment "Tohyee post box: Tohyee" >/dev/null
  echo "Opened $FTP_PORT, $PASSIVE and $API_PORT in ufw."
else
  echo "ufw isn't on, so nothing to open here."
fi
echo "If your provider has a firewall on its website too, open TCP $FTP_PORT, $PASSIVE and $API_PORT there."

say "5/5 Pairing code"
for _ in $(seq 1 30); do
  state="$(docker inspect -f '{{.State.Health.Status}}' tohyee-postbox 2>/dev/null || echo starting)"
  [ "$state" = "healthy" ] && break
  sleep 2
done
[ "${state:-}" = "healthy" ] || die "the post box didn't start. See: sudo docker logs tohyee-postbox"
docker exec tohyee-postbox node /app/postbox.cjs pairing-code
echo "Paste the code into Tohyee: Farm > Security > Post box, step 4."
echo "Need a new code later? Run: sudo docker exec tohyee-postbox node /app/postbox.cjs pairing-code"
