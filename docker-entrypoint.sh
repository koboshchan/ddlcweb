#!/bin/sh
set -eu

DDLC_SOURCE="${DDLC_ZIP:-}"

if [ -z "$DDLC_SOURCE" ]; then
  for candidate in /ddlc/ddlc-win.zip /ddlc/ddlc-mac.zip /ddlc/game /ddlc; do
    if [ -f "$candidate" ] || [ -f "$candidate/scripts.rpa" ] || [ -f "$candidate/game/scripts.rpa" ]; then
      DDLC_SOURCE="$candidate"
      break
    fi
  done
fi

if [ -z "$DDLC_SOURCE" ]; then
  echo "ERROR: No DDLC archive found." >&2
  echo "Mount your legally obtained ddlc-win.zip into /ddlc/ddlc-win.zip:" >&2
  echo "  docker run --rm -p 8080:80 -v /path/to/ddlc-win.zip:/ddlc/ddlc-win.zip:ro ddlcweb" >&2
  exit 1
fi

echo "[ddlcweb] Building app from: $DDLC_SOURCE"
DDLC_ZIP="$DDLC_SOURCE" npm run build

if [ "${BUILD_ONLY:-0}" = "1" ]; then
  mkdir -p /out
  cp -r /app/dist/* /out/
  echo "[ddlcweb] Build artifacts exported to /out"
  exit 0
fi

rm -rf /usr/share/nginx/html/*
cp -r /app/dist/* /usr/share/nginx/html/

echo "[ddlcweb] Serving on http://0.0.0.0:80"
exec nginx -g "daemon off;"
