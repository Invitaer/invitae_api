#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Starting Invitae API app (with hot reload)..."

docker network create invitae_net 2>/dev/null || true

docker compose -f docker/docker-compose.app.yml --env-file .env.local up -d --build

echo "App is running on http://localhost:3000"
echo "Source changes in ./src will be reflected automatically."
