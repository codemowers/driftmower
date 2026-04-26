FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine-slim

COPY --from=builder /app/out /usr/share/nginx/html

EXPOSE 80
