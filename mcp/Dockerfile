FROM node:24.12.0-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig*.json ./

RUN npm ci

COPY src ./src

RUN npm run build

FROM node:24.12.0-alpine

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY package*.json ./

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY config ./config

RUN addgroup -g 1001 nodejs && adduser -S nodejs -u 1001

USER nodejs

EXPOSE 3000 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
