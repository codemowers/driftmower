FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libcap2-bin \
 && setcap cap_net_bind_service=+ep "$(readlink -f "$(command -v node)")" \
 && apt-get purge -y libcap2-bin \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/server.js /app/next.config.ts /app/package.json ./

ENV NODE_ENV=production
ENV PORT=80
ENV HOSTNAME=::

USER node
EXPOSE 80
CMD ["node", "server.js"]
