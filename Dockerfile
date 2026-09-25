FROM node:22.21.0-alpine AS build
WORKDIR /work
RUN npm install --global pnpm@11.19.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22.21.0-alpine
WORKDIR /work
ENV NODE_ENV=production PORT=8080
COPY --from=build /work/node_modules ./node_modules
COPY --from=build /work/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /work/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /work/apps/api/dist ./apps/api/dist
COPY --from=build /work/apps/worker/dist ./apps/worker/dist
COPY --from=build /work/apps/web/dist ./apps/web/dist
COPY --from=build /work/docs/openapi.json ./docs/openapi.json
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/index.js"]
