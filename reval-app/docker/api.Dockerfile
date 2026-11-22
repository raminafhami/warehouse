FROM node:22.23.5-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @reval/api --omit=dev --no-audit --no-fund
COPY --chown=node:node apps/api/src apps/api/src
USER node
WORKDIR /app/apps/api
CMD ["node", "src/server.js"]
