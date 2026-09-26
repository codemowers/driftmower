FROM node:24.12.0-alpine AS development

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.build.json ./

RUN npm ci

COPY src ./src
COPY config/default.json config/custom-environment-variables.json ./config/

CMD ["node", "--import", "tsx", "--watch", "src/index.ts"]

FROM development AS builder
RUN npm run build

FROM node:24.12.0-alpine

ARG BUILD_REVISION=dev
ENV BUILD_REVISION=$BUILD_REVISION

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY config/default.json config/custom-environment-variables.json ./config/

# Build contexts may use a restrictive umask; Kubernetes can override the image UID.
RUN chmod -R a+rX /app

EXPOSE 3000 3001

CMD ["node", "dist/index.js"]
