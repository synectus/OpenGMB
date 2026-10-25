#!/bin/sh
# Picks the service for platforms that run one image per app with no per-app command (for example
# Dockerfile apps). docker-compose.yml sets each service's command explicitly and ignores this.
set -e
case "${SYNGMB_SERVICE:-web}" in
  web)
    # Migrations are idempotent; running them before web starts keeps a single-app deploy correct.
    pnpm db:migrate
    exec pnpm --filter @opengmb/web start
    ;;
  mcp) exec pnpm --filter @opengmb/mcp start ;;
  worker) exec pnpm --filter @opengmb/worker start ;;
  migrate) exec pnpm db:migrate ;;
  *)
    echo "start.sh: unknown SYNGMB_SERVICE=${SYNGMB_SERVICE}" >&2
    exit 1
    ;;
esac
