#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Starting Mailpit..."

docker network create invitae_net 2>/dev/null || true

docker compose -f docker/docker-compose.mailpit.yml up -d

echo "Mailpit SMTP is running on localhost:1025"
echo "Mailpit web UI: http://localhost:8025"
