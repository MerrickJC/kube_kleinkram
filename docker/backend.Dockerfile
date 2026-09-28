FROM kleinkram-base AS development

# Install runtime dependencies for Python (rosbags)
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install rosbags --break-system-packages --no-cache-dir
USER node

WORKDIR /app/backend

CMD ["./entrypoint.sh"]


FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install -r

# Build packages and backend
RUN pnpm --filter @kleinkram/shared build
RUN pnpm --filter @kleinkram/validation build
RUN pnpm --filter @kleinkram/api-dto build
RUN pnpm --filter @kleinkram/backend-common build
RUN NODE_ENV=production pnpm --filter kleinkram-backend build

# Reuses the full monorepo checkout from `build` (source + devDependencies)
# so the TypeORM CLI can resolve migrations/entities directly from
# TypeScript, exactly as documented in docs/development/migrations/migrations.md.
# Must create `migrator` here, before the `deploy` stage below prunes
# devDependencies out of node_modules
FROM build AS migrator

WORKDIR /app/backend

# Tells pnpm it's non-interactive so it proceeds without prompting
ENV CI=true

CMD ["pnpm", "run", "typeorm", "migration:run", "-d", "migration/prod/migration.config.ts"]

FROM build AS deploy

RUN pnpm deploy --filter=kleinkram-backend --prod --legacy /prod/backend

FROM gcr.io/distroless/nodejs22-debian12 AS production

WORKDIR /app

COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/assets/favicon.png ./backend/assets/favicon.png
COPY --from=deploy /prod/backend/node_modules ./backend/node_modules

WORKDIR /app/backend

CMD ["dist/main.js"]
