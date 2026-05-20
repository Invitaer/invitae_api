#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Stopping Invitae API app..."

docker compose -f docker/docker-compose.app.yml --env-file .env.local down

echo "App stopped."
