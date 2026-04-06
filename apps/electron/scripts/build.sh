#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
MONOREPO_ROOT="$(dirname "$(dirname "$ELECTRON_DIR")")"

echo "=== OpenAgent Desktop — Full Build ==="
echo ""

cd "$MONOREPO_ROOT"

# Install all workspace dependencies
echo "→ Installing dependencies..."
pnpm install

# Build server
echo "→ Building server..."
pnpm --filter open-agent-server build

# Build web (with API URL for embedded server)
echo "→ Building web..."
VITE_API_URL=http://localhost:3099 pnpm --filter open-agent-web build

# Build & package Electron
echo "→ Packaging Electron app..."
pnpm --filter openagent-desktop package:skip-deps

echo ""
echo "=== Done! Check apps/electron/release/ for the packaged app. ==="
