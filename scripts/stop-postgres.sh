#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Stopping PostgreSQL..."

docker compose -f docker/docker-compose.postgres.yml --env-file .env.local down

echo "PostgreSQL stopped."
