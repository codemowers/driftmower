FROM node:24.12.0-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci

COPY src ./src

RUN npm run build

FROM node:24.12.0-alpine

WORKDIR /app

RUN apk add --no-cache dumb-init python3 make g++

COPY package*.json ./

RUN npm ci --omit=dev && apk del python3 make g++

COPY --from=builder /app/dist ./dist
COPY config ./config

RUN addgroup -g 1001 nodejs && adduser -S nodejs -u 1001

USER nodejs

EXPOSE 3000 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
