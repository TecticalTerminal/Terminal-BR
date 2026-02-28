FROM node:20-bookworm-slim

WORKDIR /app

RUN corepack enable

# Foundry binaries are required by markets integration (cast/forge).
COPY --from=ghcr.io/foundry-rs/foundry:stable /usr/local/bin/cast /usr/local/bin/cast
COPY --from=ghcr.io/foundry-rs/foundry:stable /usr/local/bin/forge /usr/local/bin/forge
COPY --from=ghcr.io/foundry-rs/foundry:stable /usr/local/bin/anvil /usr/local/bin/anvil

# Copy only manifests first for better dependency layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/game-engine/package.json packages/game-engine/package.json

RUN pnpm install --frozen-lockfile

# Copy runtime source files.
COPY apps/api apps/api
COPY packages/shared-types packages/shared-types
COPY packages/game-engine packages/game-engine

EXPOSE 8787

CMD ["pnpm", "--filter", "@tactical/api", "exec", "tsx", "src/server.ts"]
