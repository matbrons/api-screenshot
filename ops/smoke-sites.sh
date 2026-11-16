#!/usr/bin/env bash
# Takes full-page shots of real sites through a running install and reports
# each one. By default a few quick sites; with --all, the whole list in
# ops/live-sites.txt, the same set `npm run live-test` runs on the engine.
#
# Real sites change and some block datacenter addresses, so a site that is
# blocked or slow is a warning. A success that isn't a real image is a failure.
# Every shot is taken anew (fresh=true), never served from the cache.
#
#   APISHOT_TEST_URL=http://127.0.0.1:3000 APISHOT_TEST_KEY=... ops/smoke-sites.sh [--all] [./shots]
#
# Writes the shots and report.md to the folder given (default ./shots).

set -uo pipefail

base="${APISHOT_TEST_URL:?set APISHOT_TEST_URL}"
base="${base%/}"
key="${APISHOT_TEST_KEY:?set APISHOT_TEST_KEY}"
all=0
if [[ "${1:-}" == "--all" ]]; then
  all=1
  shift
fi
out="${1:-shots}"
mkdir -p "$out"

QUICK=" wikipedia github stripe guardian bbc "
SITES=()
while read -r name url note; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  if [[ "$all" == 1 || "$QUICK" == *" $name "* ]]; then SITES+=("$name $url"); fi
done <"$(dirname "$0")/live-sites.txt"

failed=0
clean=0
blocked=0
other=0
rows="$out/rows.md"
: >"$rows"

for entry in "${SITES[@]}"; do
  name="${entry%% *}"
  url="${entry#* }"
  start=$(date +%s)
  code="$(printf 'Authorization: Bearer %s\n' "$key" | curl -sS -H @- -D "$out/$name.headers" -o "$out/$name.jpg" \
    -w '%{http_code}' --max-time 120 -G --data-urlencode "url=$url" \
    -d full_page=true -d format=jpeg -d image_quality=70 -d timeout=60 -d fresh=true "$base/screenshot" 2>/dev/null)"
  seconds=$(( $(date +%s) - start ))
  header() { grep -i "^$1:" "$out/$name.headers" | tail -1 | cut -d' ' -f2- | tr -d '\r'; }

  if [[ "$code" == 200 ]]; then
    magic="$(od -An -tx1 -N3 "$out/$name.jpg" | tr -d ' \n')"
    size=$(wc -c <"$out/$name.jpg" | tr -d ' ')
    if [[ "$magic" != ffd8ff || "$size" -lt 10000 ]]; then
      echo "FAIL $name: HTTP 200 but not a real image ($size bytes, first bytes $magic)"
      echo "| $name | not an image | $size bytes | | | ${seconds}s |" >>"$rows"
      failed=1
      other=$((other + 1))
    else
      removed="$(header x-removed-elements)"
      consent="$(header x-consent-manager)"
      echo "OK   $name: $((size / 1024)) KB, ${removed:-0} removed${consent:+, consent: $consent}, ${seconds}s"
      echo "| [$name]($url) | clean shot | $((size / 1024)) KB | ${removed:-0} | ${consent:--} | ${seconds}s |" >>"$rows"
      clean=$((clean + 1))
    fi
  else
    mv "$out/$name.jpg" "$out/$name.json" 2>/dev/null
    detail="$(head -c 200 "$out/$name.json" 2>/dev/null | tr '\n|' '  ')"
    echo "WARN $name: HTTP ${code:-none} after ${seconds}s: $detail"
    echo "| [$name]($url) | HTTP ${code:-none}: $detail | | | | ${seconds}s |" >>"$rows"
    if grep -q '"error":"blocked"' "$out/$name.json" 2>/dev/null; then
      blocked=$((blocked + 1))
    else
      other=$((other + 1))
    fi
  fi
  rm -f "$out/$name.headers"
done

summary="$clean clean, $blocked blocked, $other failed (of ${#SITES[@]})"
echo "$summary"
{
  echo "$summary"
  echo
  echo "| Site | Result | Size | Removed | Consent tool | Time |"
  echo "| --- | --- | --- | --- | --- | --- |"
  cat "$rows"
} >"$out/report.md"
rm -f "$rows"

exit "$failed"
