#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Starting all Invitae API services..."

docker compose --env-file .env.develop up -d --build

echo ""
echo "All services are up:"
echo "  App      -> http://localhost:3000"
echo "  Postgres -> localhost:5432"
echo "  Redis    -> localhost:6379"
