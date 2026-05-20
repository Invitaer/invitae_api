#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Starting Redis..."

docker network create invitae_net 2>/dev/null || true

docker compose -f docker/docker-compose.redis.yml --env-file .env.local up -d

echo "Redis is running on localhost:6379"
