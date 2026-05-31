FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/server.js /app/next.config.ts /app/package.json ./

ENV NODE_ENV=production
ENV PORT=80
ENV HOSTNAME=::

EXPOSE 80
CMD ["node", "server.js"]
