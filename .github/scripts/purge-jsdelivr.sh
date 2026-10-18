#!/usr/bin/env bash
# Purges jsDelivr @main and waits for the CDN to serve main's VERSION. Shared by
# purge-jsdelivr.yml (push, release, manual) and cdn-heal.yml (every 3 h, with --if-stale).
#
# jsDelivr throttles repeated purges of the same URL and can be unable to reach GitHub for an
# hour (14 Oct). Neither is a failure: each file is purged once per run, and throttling
# and a CDN that's still stale after 20 minutes are warnings. cdn-heal.yml purges again while
# the CDN's VERSION differs from main's, so a missed refresh heals itself.
#
# Needs REPO (owner/name). Run from the repository root.
set -u

PURGE=https://purge.jsdelivr.net/gh/$REPO@main
CDN=https://cdn.jsdelivr.net/gh/$REPO@main/gradientConnectBar.js

expected=$(grep -oP 'const VERSION = "\K[^"]+' gradientConnectBar.js)
served() { curl -fsS --max-time 60 "$CDN" 2>/dev/null | grep -oP 'const VERSION = "\K[^"]+' | head -n 1; }

# One purge request; sets $throttled. Throttling or a failed request is only a warning.
purge() {
  throttled=false
  local json
  if ! json=$(curl -fsS --max-time 60 "$PURGE/$1"); then
    echo "::warning::Purge request for $1 failed"
    return
  fi
  echo "$1: $json"
  if grep -Eq '"throttled":[[:space:]]*true' <<<"$json"; then
    throttled=true
    echo "::warning::jsDelivr throttled the purge of $1"
  fi
}

if [ "${1:-}" = --if-stale ]; then
  now=$(served)
  if [ "$now" = "$expected" ]; then
    echo "CDN serves $now, same as main. Nothing to do."
    exit 0
  fi
  echo "CDN serves ${now:-nothing}, main has $expected: purging."
fi

for file in gradientConnectBar.js manifest.json README.md preview.png; do
  purge "$file"
  if [ "$file" = gradientConnectBar.js ]; then js_throttled=$throttled; fi
done

# Poll every 2 min for up to 20 min. Re-purge only the script, and only while jsDelivr
# isn't throttling it, since every extra purge of a throttled URL adds to the throttle.
deadline=$((SECONDS + 20 * 60))
while :; do
  now=$(served)
  echo "CDN serves ${now:-nothing}, expected $expected"
  if [ "$now" = "$expected" ]; then
    echo "The CDN serves the pushed version."
    exit 0
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    break
  fi
  sleep 120
  if [ "$js_throttled" = false ]; then
    purge gradientConnectBar.js
    js_throttled=$throttled
  fi
done
echo "::warning::jsDelivr still serves ${now:-nothing} after 20 min, expected $expected. cdn-heal.yml (every 3 h) purges again until it matches."
