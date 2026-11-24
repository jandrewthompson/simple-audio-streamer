#!/usr/bin/env bash
# Verify the running server: page, manifest, types, caching and HTTP ranges.
set -euo pipefail

PYTHON="${PYTHON:-python3}"
BASE="${BASE_URL:-http://127.0.0.1:8099}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass=0
fail=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf 'ok   %-42s %s\n' "$name" "$actual"
    pass=$((pass + 1))
  else
    printf 'FAIL %-42s expected %s, got %s\n' "$name" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

header() { # header <url> <name>
  curl -sI "$1" | tr -d '\r' \
    | awk -F': ' -v name="$2" 'tolower($1)==name {print $2; exit}'
}

cache_control() { # one token per line
  curl -sI "$1" | tr -d '\r' \
    | awk -F': ' 'tolower($1)=="cache-control"{print $2}' \
    | tr ',' '\n' | sed 's/^ *//; s/ *$//'
}

has_token() { # has_token <url> <token>
  cache_control "$1" | grep -qx -- "$2" && echo yes || echo no
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if ! curl -sf "$BASE/playlist.json" -o "$tmp/served.json"; then
  echo "FAIL cannot fetch $BASE/playlist.json" >&2
  exit 1
fi

mapfile -t tracks < <("$PYTHON" - "$tmp/served.json" <<'PY'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)

expected = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".m4b": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
}

tracks = [track for album in manifest["albums"] for track in album["tracks"]]
if not tracks:
    sys.exit("manifest contains no tracks")

for track in tracks:
    ext = os.path.splitext(track["src"])[1].lower()
    print(f'{track["src"]}\t{expected.get(ext, "audio/")}')
PY
)

if [[ "${#tracks[@]}" -eq 0 ]]; then
  echo "FAIL served manifest has no tracks" >&2
  exit 1
fi

track_src="${tracks[0]%%$'\t'*}"
track_url="$BASE/$track_src"
total="$(header "$track_url" content-length)"

echo "server: $BASE"
echo "track:  $track_url"
echo

check "GET /"                       200 "$(status "$BASE/")"
check "page has audio element"      yes "$(curl -s "$BASE/" | grep -q 'id="audio"' && echo yes || echo no)"
check "GET /assets/app.js"          200 "$(status "$BASE/assets/app.js")"
check "GET /assets/styles.css"      200 "$(status "$BASE/assets/styles.css")"
check "GET /playlist.json"          200 "$(status "$BASE/playlist.json")"
check "GET /missing"                404 "$(status "$BASE/does-not-exist")"
check "GET /data/"                  403 "$(status "$BASE/data/")"
check "GET /healthz"                200 "$(status "$BASE/healthz")"
check "dotfile denied"              403 "$(status "$BASE/.git/config")"
check "hidden data file denied"     403 "$(status "$BASE/data/.hidden")"

check "HEAD track"                  200 "$(curl -sI "$track_url" | tr -d '\r' | awk 'NR==1{print $2}')"
check "Accept-Ranges"               bytes "$(header "$track_url" accept-ranges)"
check "audio Cache-Control max-age" yes "$(has_token "$track_url" max-age=31536000)"
check "audio not compressed"        "" "$(curl -sI -H 'Accept-Encoding: gzip' "$track_url" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-encoding"{print $2}')"
check "playlist revalidates"        yes "$(has_token "$BASE/playlist.json" no-cache)"
check "page revalidates"            yes "$(has_token "$BASE/" no-cache)"
check "assets cache briefly"        yes "$(has_token "$BASE/assets/app.js" max-age=3600)"
check "CSP same-origin"             yes "$(curl -sI "$BASE/" | tr -d '\r' | grep -qi "^content-security-policy:.*default-src 'self'.*script-src 'self'" && ! curl -sI "$BASE/" | grep -qi 'unsafe-inline' && echo yes || echo no)"
check "nosniff present"             yes "$(curl -sI "$BASE/" | tr -d '\r' | grep -qi '^x-content-type-options: *nosniff' && echo yes || echo no)"

etag="$(header "$BASE/playlist.json" etag)"
check "playlist conditional 304"    304 "$(status -H "If-None-Match: $etag" "$BASE/playlist.json")"

# Every advertised track must be served with a playable audio type.
bad_types=0
for entry in "${tracks[@]}"; do
  src="${entry%%$'\t'*}"
  want="${entry#*$'\t'}"
  got="$(header "$BASE/$src" content-type)"
  case "$got" in
    "$want"*) ;;
    *) printf 'FAIL %-42s expected %s, got %s\n' "type ${src##*/}" "$want" "$got"; bad_types=$((bad_types + 1)) ;;
  esac
done
check "all tracks have audio MIME"  0 "$bad_types"

range_headers="$(curl -sI -r 0-99 "$track_url" | tr -d '\r')"
check "range status"                206 "$(printf '%s\n' "$range_headers" | awk 'NR==1{print $2}')"
check "Content-Range 0-99/total"    "bytes 0-99/$total" "$(printf '%s\n' "$range_headers" | awk -F': ' 'tolower($1)=="content-range"{print $2}')"
check "range body length"           100 "$(curl -s -r 0-99 "$track_url" | wc -c | tr -d ' ')"
check "unsatisfiable range"         416 "$(status -r 999999999- "$track_url")"
check "416 not cached for a year"   no "$(curl -sI -r 999999999- "$track_url" | tr -d '\r' | grep -qi 'max-age=31536000' && echo yes || echo no)"

echo
if [[ "$fail" -gt 0 ]]; then
  echo "$fail check(s) failed, $pass passed"
  exit 1
fi
echo "all $pass checks passed"
