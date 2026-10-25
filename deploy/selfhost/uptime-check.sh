#!/bin/bash
# H2 uptime check. The app cannot tell you it is down, so run this from cron on a machine OTHER
# than the app server (or at least outside the app's containers). It fetches /api/health; when the
# check fails it sends ONE email through the Resend HTTP API, and ONE more when the app is back.
# A state file records "currently down", so a long outage is one email, not one per run.
#
#   HEALTH_URL      required, e.g. https://opengmb.example.com/api/health
#   RESEND_API_KEY  required (same key the app uses)
#   EMAIL_FROM      required, an address on a Resend-verified domain
#   ALERT_EMAIL     required, where the alert goes (an address you read)
#   STATE_FILE      default /var/tmp/syngmb-uptime.state
#   TIMEOUT_SECONDS default 10
#   UPTIME_DRY_RUN  1 = print "would send ..." instead of calling Resend (for testing)
#
# Exit code: 0 healthy, 1 unhealthy, 2 misconfigured. If the email cannot be sent the state file is
# NOT written, so the next run tries again.
#
# Test it (does not touch Resend):
#   UPTIME_DRY_RUN=1 HEALTH_URL=http://127.0.0.1:9/api/health ALERT_EMAIL=x@example.test \
#     EMAIL_FROM=a@example.test RESEND_API_KEY=x STATE_FILE=/tmp/h2-state ./uptime-check.sh
set -uo pipefail

: "${HEALTH_URL:?HEALTH_URL is required}"
: "${ALERT_EMAIL:?ALERT_EMAIL is required}"
: "${EMAIL_FROM:?EMAIL_FROM is required}"
: "${RESEND_API_KEY:?RESEND_API_KEY is required}"
STATE_FILE="${STATE_FILE:-/var/tmp/syngmb-uptime.state}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-10}"

send() { # subject, text. Only fixed strings and the URL go in; no quoting of user data needed.
  local subject="$1" text="$2"
  if [ "${UPTIME_DRY_RUN:-0}" = "1" ]; then
    echo "would send to $ALERT_EMAIL: $subject"
    return 0
  fi
  local body
  body=$(printf '{"from":"%s","to":"%s","subject":"%s","text":"%s"}' "$EMAIL_FROM" "$ALERT_EMAIL" "$subject" "$text")
  curl -fsS -m 20 -X POST https://api.resend.com/emails \
    -H "authorization: Bearer $RESEND_API_KEY" \
    -H "content-type: application/json" \
    -d "$body" >/dev/null
}

# Healthy means HTTP 200 and a body containing "ok":true (what /api/health returns).
resp=$(curl -sS -m "$TIMEOUT_SECONDS" -w '\n%{http_code}' "$HEALTH_URL" 2>&1) || true
code=$(printf '%s' "$resp" | tail -n1)
if [ "$code" = "200" ] && printf '%s' "$resp" | grep -q '"ok":true'; then
  if [ -f "$STATE_FILE" ]; then
    since=$(cat "$STATE_FILE")
    if send "[SynGMB] Site is back" "$HEALTH_URL is answering again (it was down since $since)."; then
      rm -f "$STATE_FILE"
    fi
  fi
  echo "ok $HEALTH_URL"
  exit 0
fi

if [ -f "$STATE_FILE" ]; then
  echo "still down $HEALTH_URL (already alerted since $(cat "$STATE_FILE"))"
  exit 1
fi
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if send "[SynGMB] Site is down" "$HEALTH_URL did not answer healthy within ${TIMEOUT_SECONDS}s (HTTP status: ${code:-none}) at $now. You will get one more email when it is back."; then
  echo "$now" > "$STATE_FILE"
  echo "down, alert sent $HEALTH_URL"
else
  echo "down, alert could NOT be sent; will retry next run" >&2
fi
exit 1
