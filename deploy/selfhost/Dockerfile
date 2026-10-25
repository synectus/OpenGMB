# One image for web, mcp, worker and the migrate job; docker-compose.yml picks the command.
# Build context is the repository root:  docker build -f deploy/selfhost/Dockerfile .
FROM node:22-slim AS build
RUN npm install -g pnpm@10.15.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# next build needs no database or secrets (the db and auth instances are created lazily).
RUN pnpm --filter @opengmb/web build

# Runtime keeps the workspace as built: the node apps run from source with tsx, web with next start.
FROM node:22-slim AS runtime
# curl: platform health checks (the hosting platform runs curl/wget inside the container).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.15.0
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000 3100 3200
CMD ["sh", "deploy/selfhost/start.sh"]
