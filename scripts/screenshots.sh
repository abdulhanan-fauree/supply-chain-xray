#!/usr/bin/env bash
#
# Captures the README screenshots from a running server.
#
# Kept in the repo so the images can be regenerated after a UI change instead of
# going stale — a README with screenshots of an older design is worse than one
# with none.
#
# Usage:
#   npm run build && npm run start &   # or npm run dev
#   ./scripts/screenshots.sh [base-url]
#
# Requires Google Chrome. Writes PNGs to docs/screenshots/.

set -euo pipefail

BASE_URL="${1:-http://localhost:3100}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/docs/screenshots"
WINDOW="${WINDOW:-1440,1100}"

if [[ ! -x "$CHROME" ]]; then
  echo "Chrome not found at: $CHROME" >&2
  echo "Set CHROME=/path/to/chrome and retry." >&2
  exit 1
fi

if ! curl -sf -o /dev/null "$BASE_URL/"; then
  echo "No server responding at $BASE_URL — start one with 'npm run start' first." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# name|path|window triples. Names become the PNG filenames the README references.
#
# Window height is per-page on purpose. Chrome's --screenshot captures the
# viewport from the top with no way to scroll, so a page whose most important
# content sits below a tall panel needs a taller window or the screenshot shows
# only the preamble. legacy-admin's dependency chains sat under a 10-row fix
# point table and were cut off entirely at 1100px.
PAGES=(
  "01-overview|/|1440,1100"
  "02-install-tree|/apps/legacy-admin|1440,1250"
  "03-blast-radius-chain|/apps/storefront-web|1440,1750"
  "04-app-clean|/apps/mobile-companion|1440,1400"
  "05-advisories|/vulnerabilities?severity=CRITICAL|1440,1250"
  "06-advisory-detail|/vulnerabilities/GHSA-vh95-rmgr-6w4m|1440,1300"
  "07-choke-points|/packages?show=undeclared|1440,1350"
  "08-package-detail|/packages/minimist|1440,1400"
  "09-trust|/maintainers|1440,1500"
  "10-explore|/explore?from=handlebars&to=minimist|1440,1150"
  "11-queries|/queries|1440,1600"
)

for entry in "${PAGES[@]}"; do
  IFS='|' read -r name path window <<< "$entry"
  window="${window:-$WINDOW}"

  # Warm the route first: a dynamic page screenshotted cold captures its loading
  # skeleton rather than its content.
  curl -sf -o /dev/null "$BASE_URL$path" || true

  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --window-size="$window" \
    --virtual-time-budget=6000 \
    --screenshot="$OUT_DIR/$name.png" \
    "$BASE_URL$path" >/dev/null 2>&1

  if [[ -f "$OUT_DIR/$name.png" ]]; then
    size=$(( $(wc -c < "$OUT_DIR/$name.png") / 1024 ))
    printf '  %-24s %-40s %-11s %4s KB\n' "$name" "$path" "$window" "$size"
  else
    printf '  %-24s %-38s FAILED\n' "$name" "$path"
  fi
done

echo
echo "Wrote $(ls -1 "$OUT_DIR"/*.png 2>/dev/null | wc -l | tr -d ' ') screenshots to docs/screenshots/"
