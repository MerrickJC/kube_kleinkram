FROM kleinkram-base AS builder

COPY --chown=node:node packages/shared/tsconfig.json ./packages/shared/
COPY --chown=node:node packages/shared/src ./packages/shared/src
COPY --chown=node:node packages/validation/tsconfig.json ./packages/validation/
COPY --chown=node:node packages/validation/src ./packages/validation/src
COPY --chown=node:node packages/api-dto/tsconfig.json ./packages/api-dto/
COPY --chown=node:node packages/api-dto/src ./packages/api-dto/src
COPY --chown=node:node packages/backend-common/tsconfig.json ./packages/backend-common/
COPY --chown=node:node packages/backend-common/src ./packages/backend-common/src

RUN pnpm --filter @kleinkram/shared build
RUN pnpm --filter @kleinkram/validation build
RUN pnpm --filter @kleinkram/api-dto build
RUN pnpm --filter @kleinkram/backend-common build
