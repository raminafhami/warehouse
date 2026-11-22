FROM node:22.23.5-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @reval/web --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build --workspace @reval/web

FROM nginx:1.28.0-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
