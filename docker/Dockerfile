# Development/production-shaped image for api and worker (Phase 1).
# The web app is built separately (next build) and served by its own runtime.
FROM node:24-bookworm-slim

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=true

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @job-system/api --filter @job-system/worker run build

CMD ["node", "apps/api/dist/main.js"]