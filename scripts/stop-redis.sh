#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Stopping Redis..."

docker compose -f docker/docker-compose.redis.yml --env-file .env.local down

echo "Redis stopped."
