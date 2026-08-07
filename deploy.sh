#!/bin/bash
# StepMail redeploy: rebuilds and recreates backend + frontend containers.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  if [ -d "/workspace/docker-compose.yml" ] || [ -f "/workspace/docker-compose.yml" ]; then
    PROJECT_DIR="/workspace"
  elif [ -f "/root/temp-email/docker-compose.yml" ]; then
    PROJECT_DIR="/root/temp-email"
  else
    PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
fi
LOG_DIR="${PROJECT_DIR}/deploy-logs"
LOG_FILE="${LOG_DIR}/redeploy-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "${LOG_DIR}"

log() { echo "[$(date '+%F %T')] $*"; }

{
  log "=== StepMail redeploy started ==="
  cd "${PROJECT_DIR}"

  log "Rebuilding frontend image (VITE_API_URL=https://stepmail.tech) ..."
  docker build \
    --build-arg VITE_API_URL=https://stepmail.tech \
    --build-arg NODE_ENV=production \
    -t temp-email-frontend:latest \
    ./frontend

  log "Rebuilding backend image ..."
  docker build -t temp-email-backend:latest ./backend

  log "Recreating frontend container ..."
  docker compose up -d frontend

  log "Recreating backend container ..."
  docker compose up -d backend

  log "Health check ..."
  sleep 3
  if docker ps --format '{{.Names}}' | grep -q '^disposable-backend$'; then
    log "Backend container is running."
  else
    log "WARNING: backend container is not running!"
  fi
  if docker ps --format '{{.Names}}' | grep -q '^disposable-frontend$'; then
    log "Frontend container is running."
  else
    log "WARNING: frontend container is not running!"
  fi

  log "=== StepMail redeploy finished ==="
} >> "${LOG_FILE}" 2>&1

echo "log: ${LOG_FILE}"
