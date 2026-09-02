#!/usr/bin/env bash
# all-code.sh — run from the repo root (or anywhere): writes all-code.txt
# containing every SOURCE file (js/go/html/css + manifests), each headed by
# its path. Docs, decks, dumps and binaries are excluded.
# Overwrites the output file every run.

cd "$(dirname "$0")"
OUT=all-code.txt

find . -type f \
  \( -name '*.js' -o -name '*.go' -o -name '*.html' -o -name '*.css' -o \
     -path './extension/manifest.json' -o -name 'go.mod' \) \
  ! -path './.git/*' \
  ! -path './test-artifacts/*' \
  ! -path './node_modules/*' \
  ! -path './resources/*' \
  ! -name 'all-code.txt' \
  ! -name 'all-code.sh' \
  ! -name 'e2e-run.exe' \
  | sort | while read -r f; do
      echo "=== ${f#./} ==="
      cat "$f"
      echo ""
    done > "$OUT"

COUNT=$(grep -c '^=== ' "$OUT")
SIZE=$(du -h "$OUT" | cut -f1)
echo "Wrote $OUT — $COUNT files, $SIZE"
