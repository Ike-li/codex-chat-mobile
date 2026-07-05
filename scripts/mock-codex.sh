#!/bin/sh
# scripts/mock-codex.sh —— Mock codex binary for E2E testing.
# When called with 'app-server' argument, runs the mock app-server.
# Usage: CODEX_BIN=./scripts/mock-codex.sh node server.js
if [ "$1" = "app-server" ]; then
  exec node "$(dirname "$0")/mock-codex-app-server.js"
else
  echo "mock-codex 0.1.0"
  exit 0
fi
