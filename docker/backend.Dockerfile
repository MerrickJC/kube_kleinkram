FROM kleinkram-base AS development

# Install runtime dependencies for Python (rosbags)
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install rosbags --break-system-packages --no-cache-dir
USER node

WORKDIR /app/backend

CMD ["./entrypoint.sh"]


FROM kleinkram-builder AS build

COPY --chown=node:node backend/ ./backend/

RUN NODE_ENV=production pnpm --filter kleinkram-backend build
# Standalone entry point for the db-dumper CronJob image below. Compiled with
# plain tsc since it has no @kleinkram/* or Nest dependencies
RUN pnpm --filter kleinkram-backend build:db-dump

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

# pnpm deploy writes outside /app (into /prod), which the non-root `node`
# user (inherited from kleinkram-base) can't create at the filesystem root
USER root
RUN pnpm deploy --filter=kleinkram-backend --prod --legacy /prod/backend

FROM gcr.io/distroless/nodejs22-debian12 AS production

WORKDIR /app

COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/assets/favicon.png ./backend/assets/favicon.png
COPY --from=deploy /prod/backend/node_modules ./backend/node_modules

WORKDIR /app/backend

CMD ["dist/main.js"]

# Runs the DB dump script in a Kubernetes CronJob. Requires a shell so it can't
# reuse the distroless `production` image above
FROM node:22-slim AS db-dumper

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates gnupg curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && apt-get purge -y --auto-remove gnupg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY --from=build /app/backend/dist/db-dump-standalone.js ./dist/db-dump-standalone.js
COPY --from=deploy /prod/backend/node_modules ./node_modules

USER node

CMD ["node", "dist/db-dump-standalone.js"]
