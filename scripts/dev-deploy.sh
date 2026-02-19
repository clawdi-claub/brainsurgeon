#!/usr/bin/env bash
# Dev deploy: sync extension files to ~/.openclaw/extensions/brainsurgeon/
# Usage: ./scripts/dev-deploy.sh [--link]
#
# Default: rsync files (safe, works always)
# --link:  symlink the extensions/brainsurgeon/ directory (faster for dev,
#          but OpenClaw may reject if ownership/permissions don't match)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_ROOT/extensions/brainsurgeon"
DEST_DIR="$HOME/.openclaw/extensions/brainsurgeon"

if [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: Source not found: $SRC_DIR" >&2
  exit 1
fi

if [ "${1:-}" = "--link" ]; then
  # Symlink mode — NOTE: OpenClaw may reject symlinks that resolve
  # outside the plugin root. Use rsync (default) if discovery fails.
  echo "Linking $SRC_DIR → $DEST_DIR"
  echo "WARNING: OpenClaw may reject external symlinks. Use rsync mode if plugin is not discovered."
  
  # Remove existing (file, symlink, or directory)
  if [ -L "$DEST_DIR" ] || [ -e "$DEST_DIR" ]; then
    rm -rf "$DEST_DIR"
  fi
  
  mkdir -p "$(dirname "$DEST_DIR")"
  ln -s "$SRC_DIR" "$DEST_DIR"
  echo "Symlinked. Verify: ls -la $DEST_DIR"
else
  # Rsync mode (default, recommended)
  echo "Syncing $SRC_DIR → $DEST_DIR"
  
  # Remove existing symlink if present (rsync can't overwrite symlinks to dirs)
  if [ -L "$DEST_DIR" ]; then
    rm "$DEST_DIR"
  fi
  
  mkdir -p "$DEST_DIR"
  rsync -av --delete \
    --exclude='node_modules' \
    --exclude='.git' \
    "$SRC_DIR/" "$DEST_DIR/"
  echo "Synced."
fi

echo ""
echo "Extension deployed to: $DEST_DIR"
echo "Files:"
ls -la "$DEST_DIR"
echo ""
echo "NOTE: Do NOT add brainsurgeon to plugins.allow in openclaw.json"
echo "      until the extension is fully tested and ready."
