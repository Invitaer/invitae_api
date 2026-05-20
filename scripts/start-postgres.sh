#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Starting PostgreSQL..."

docker network create invitae_net 2>/dev/null || true

docker compose -f docker/docker-compose.postgres.yml --env-file .env.local up -d

echo "PostgreSQL is running on localhost:5432"
