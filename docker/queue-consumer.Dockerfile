FROM kleinkram-base AS development

USER root
RUN apt-get update && apt-get install -y curl && \
    curl -sL "https://github.com/google/go-containerregistry/releases/download/v0.19.1/go-containerregistry_Linux_x86_64.tar.gz" > crane.tar.gz && \
    tar -zxvf crane.tar.gz -C /usr/local/bin/ crane && \
    rm crane.tar.gz && \
    curl -sL "https://github.com/foxglove/mcap/releases/latest/download/mcap-linux-amd64" -o /usr/local/bin/mcap && \
    chmod +x /usr/local/bin/mcap && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
USER node

WORKDIR /app/queueConsumer

CMD ["pnpm", "start:dev"]


FROM kleinkram-builder AS build

COPY --chown=node:node queueConsumer/ ./queueConsumer/

RUN NODE_ENV=production pnpm --filter kleinkram-queue-consumer build

# pnpm deploy writes outside /app (into /prod), which the non-root `node`
# user (inherited from kleinkram-base) can't create at the filesystem root
USER root
RUN pnpm deploy --filter=kleinkram-queue-consumer --prod --legacy /prod/queueConsumer

FROM node:22-slim AS production

RUN apt-get update && apt-get install -y curl ca-certificates && \
    # Install Crane \
    curl -sL "https://github.com/google/go-containerregistry/releases/download/v0.19.1/go-containerregistry_Linux_x86_64.tar.gz" > crane.tar.gz && \
    tar -zxvf crane.tar.gz -C /usr/local/bin/ crane && \
    rm crane.tar.gz && \
    # Install Mcap \
    curl -sL "https://github.com/foxglove/mcap/releases/latest/download/mcap-linux-amd64" -o /usr/local/bin/mcap && \
    chmod +x /usr/local/bin/mcap && \
    # Cleanup \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/queueConsumer/dist ./queueConsumer/dist
COPY --from=build /prod/queueConsumer/node_modules ./queueConsumer/node_modules

WORKDIR /app/queueConsumer

CMD ["node", "dist/main.js"]
