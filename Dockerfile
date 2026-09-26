FROM node:22.21.0-bookworm-slim@sha256:f9f7f95dcf1f007b007c4dcd44ea8f7773f931b71dc79d57c216e731c87a090b AS build
WORKDIR /app
RUN npm install --global pnpm@11.19.0 && test "$(pnpm --version)" = "11.19.0"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY docs/openapi.json ./docs/openapi.json
COPY scripts/container-build.mjs ./scripts/container-build.mjs
RUN pnpm install --frozen-lockfile
ARG VITE_APP_ENV
ARG VITE_TERMS_VERSION
RUN VITE_APP_ENV="$VITE_APP_ENV" VITE_TERMS_VERSION="$VITE_TERMS_VERSION" node scripts/container-build.mjs

FROM node:22.21.0-bookworm-slim@sha256:f9f7f95dcf1f007b007c4dcd44ea8f7773f931b71dc79d57c216e731c87a090b AS runtime
WORKDIR /app
ENV NODE_ENV=production REALADDR_REPO_ROOT=/app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/docs/openapi.json ./docs/openapi.json
COPY --chown=node:node scripts/container-entrypoint.mjs ./scripts/container-entrypoint.mjs
USER node
EXPOSE 8080
ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]
CMD ["web"]
