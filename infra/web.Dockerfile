FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build
FROM nginx:stable-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY infra/trusted-proxy.conf /etc/nginx/trusted-proxy.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
