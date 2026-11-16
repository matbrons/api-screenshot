#!/usr/bin/env bash
# Checks a running deployment from the outside: it is up, it refuses requests
# without the key, it returns a real screenshot of a public page, and its MCP
# endpoint lists its tools.
#
#   APISHOT_TEST_URL=https://api-screenshot.example.workers.dev APISHOT_TEST_KEY=... ops/watch.sh
#
# Settings (environment variables):
#   APISHOT_TEST_URL      base URL of the deployment, for example http://127.0.0.1:3000
#   APISHOT_WORKERS_SUBDOMAIN, APISHOT_WORKER_NAME
#                         instead of the URL: https://<name>.<subdomain>.workers.dev
#                         (name defaults to apiscreenshot-test)
#   APISHOT_TEST_KEY      the deployment's API key
#   APISHOT_TEST_PAGE     the page to shoot (default https://example.com)
#
# Prints one line per check, starting with OK, WARN or FAIL, and exits 1 when
# any check fails. Never prints the key. Needs bash, curl and od.

set -uo pipefail

failed=0
ok() { echo "OK   $*"; }
warn() { echo "WARN $*"; }
fail() { echo "FAIL $*"; failed=1; }

base="${APISHOT_TEST_URL:-}"
if [[ -z "$base" && -n "${APISHOT_WORKERS_SUBDOMAIN:-}" ]]; then
  base="https://${APISHOT_WORKER_NAME:-apiscreenshot-test}.${APISHOT_WORKERS_SUBDOMAIN}.workers.dev"
fi
if [[ -z "$base" ]]; then
  fail "config: set APISHOT_TEST_URL (or APISHOT_WORKERS_SUBDOMAIN)"
  exit 1
fi
base="${base%/}"
page="${APISHOT_TEST_PAGE:-https://example.com}"

key="${APISHOT_TEST_KEY:-}"
if [[ -z "$key" ]]; then
  fail "config: no API key (set APISHOT_TEST_KEY)"
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 1. Up
code="$(curl -sS -o "$tmp/health" -w '%{http_code}' --max-time 20 "$base/health" 2>"$tmp/err")"
if [[ "$code" == 200 ]] && grep -q '"ok":true' "$tmp/health"; then
  ok "health: $base answers"
else
  fail "health: $base/health gave HTTP ${code:-none} $(head -c 200 "$tmp/err" "$tmp/health" 2>/dev/null | tr '\n' ' ')"
  exit 1
fi

# 2. Closed to strangers. The key is checked before any browser starts, so this costs nothing.
# A key set a moment ago can take a few seconds to reach every location, so a
# "not configured" answer is retried for about half a minute before it counts.
for attempt in 1 2 3 4 5 6; do
  code="$(curl -sS -o "$tmp/open" -w '%{http_code}' --max-time 20 -G --data-urlencode "url=$page" "$base/screenshot" 2>/dev/null)"
  [[ "$code" == 503 ]] && grep -q '"not_configured"' "$tmp/open" && (( attempt < 6 )) || break
  sleep 5
done
case "$code" in
  401) ok "auth: refuses a request without the key" ;;
  503)
    if grep -q '"not_configured"' "$tmp/open"; then
      fail "auth: no usable API_KEY on the deployment, so it serves nothing: $(grep -o '"message":"[^"]*"' "$tmp/open" | head -c 200)"
      exit 1
    fi
    fail "auth: a request without the key got HTTP 503 instead of 401" ;;
  200) fail "auth: a request without the key got a screenshot; the deployment is open to anyone" ;;
  *) fail "auth: a request without the key got HTTP ${code:-none} instead of 401" ;;
esac

# 3. A real screenshot, taken fresh rather than from the cache. The header comes from stdin so the key stays out of the process list.
start=$(date +%s)
code="$(printf 'Authorization: Bearer %s\n' "$key" | curl -sS -H @- -D "$tmp/headers" -o "$tmp/shot" \
  -w '%{http_code}' --max-time 90 -G --data-urlencode "url=$page" -d full_page=true -d fresh=true "$base/screenshot" 2>"$tmp/err")"
seconds=$(( $(date +%s) - start ))
header() { grep -i "^$1:" "$tmp/headers" | tail -1 | cut -d' ' -f2- | tr -d '\r'; }

if [[ "$code" != 200 ]]; then
  detail="$(head -c 300 "$tmp/shot" 2>/dev/null | tr '\n' ' ')"
  if [[ "$code" == 503 || "$code" == 429 ]] && grep -q '"busy"' "$tmp/shot"; then
    warn "shot: no browser free right now (HTTP $code), try again later: $detail"
  elif [[ "$code" == 429 ]] && grep -q '"quota_exceeded"' "$tmp/shot"; then
    warn "shot: the account's browser time for today is used up, so no shot could be taken: $detail"
  else
    fail "shot: HTTP ${code:-none} for $page after ${seconds}s: ${detail:-$(head -c 200 "$tmp/err")}"
  fi
  exit "$failed"
fi

type="$(header content-type)"
size=$(wc -c <"$tmp/shot" | tr -d ' ')
magic="$(od -An -tx1 -N8 "$tmp/shot" | tr -d ' \n')"
if [[ "$type" != image/png* || "$magic" != 89504e470d0a1a0a ]]; then
  fail "shot: HTTP 200 but not a PNG (content-type ${type:-none}, first bytes ${magic:-none})"
  exit 1
fi
# Width and height sit in the IHDR chunk, bytes 16 to 23, big-endian.
read -r w1 w2 w3 w4 h1 h2 h3 h4 < <(od -An -tu1 -j16 -N8 "$tmp/shot")
width=$(( (w1 << 24) | (w2 << 16) | (w3 << 8) | w4 ))
height=$(( (h1 << 24) | (h2 << 16) | (h3 << 8) | h4 ))
if (( width < 240 || height < 240 || size < 3000 )); then
  fail "shot: PNG too small to be a page (${width}x${height}, ${size} bytes)"
else
  ok "shot: ${width}x${height} PNG, $((size / 1024)) KB of $page in ${seconds}s (site answered $(header x-target-status))"
fi
if (( seconds > 45 )); then
  warn "shot: took ${seconds}s"
fi

# 4. The MCP endpoint answers with its tools, for AI clients.
code="$(printf 'Authorization: Bearer %s\n' "$key" | curl -sS -H @- -o "$tmp/mcp" -w '%{http_code}' --max-time 20 \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$base/mcp" 2>/dev/null)"
if [[ "$code" == 200 ]] && grep -q '"name":"screenshot"' "$tmp/mcp"; then
  ok "mcp: lists its tools"
else
  fail "mcp: tools/list gave HTTP ${code:-none} $(head -c 200 "$tmp/mcp" 2>/dev/null | tr '\n' ' ')"
fi

exit "$failed"
