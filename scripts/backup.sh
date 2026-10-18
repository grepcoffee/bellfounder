#!/usr/bin/env bash
# Tars up the bellfounder_data volume (SQLite DB + any opted-in WAVs).
# Run from the Ubuntu box, e.g. via cron: 0 3 * * * /path/to/backup.sh
set -euo pipefail

VOLUME_NAME="${BF_VOLUME_NAME:-bellfounder_data}"
DEST_DIR="${BF_BACKUP_DIR:-$HOME/bellfounder-backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEST_FILE="$DEST_DIR/bellfounder-$TIMESTAMP.tar.gz"

mkdir -p "$DEST_DIR"

docker run --rm \
  -v "$VOLUME_NAME":/data:ro \
  -v "$DEST_DIR":/backup \
  alpine \
  tar czf "/backup/bellfounder-$TIMESTAMP.tar.gz" -C / data

echo "Wrote $DEST_FILE"

# Keep the last 30 backups, drop older ones.
ls -1t "$DEST_DIR"/bellfounder-*.tar.gz 2>/dev/null | tail -n +31 | xargs -r rm --
