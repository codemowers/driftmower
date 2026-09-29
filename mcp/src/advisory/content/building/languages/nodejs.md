# Building Node.js containers

- Use a pinned Node version shared across build stages. Install dependencies with the lockfile during the build, exclude npm credentials, and omit development-only packages from production.
- Launch production containers directly with exec-form `CMD ["node", "server.js"]` (or the application's built entry file). Avoid `npm start`, `npm run`, `npx`, and package-manager wrappers as production entrypoints. They add a process layer and can invoke lifecycle hooks or package resolution/download behavior, depending on the command and configuration. Runtime startup must not install dependencies or compile assets.
- Package managers remain appropriate for dependency installation, builds, tests, and interactive local development. A package.json `start` script is not itself a finding if the production container launches Node directly.
- Handle SIGTERM in the application; do not add dumb-init or a process supervisor by default. See `building/general` for runtime identity and the documented legacy-port exception.
- Keep runtime configuration in files the image copies in, such as a `config/` directory, or in environment variables read at startup. Do not generate config with shell in a `RUN` step.

## Sample Dockerfile

A TypeScript service compiled to `dist/` and run by `node` directly. The `deps` stage installs everything the build needs from the lockfile; the runtime stage installs again with `--omit=dev` so no compiler or test tooling ships. The official image's `node` user is the runtime identity.

```dockerfile
# syntax=docker/dockerfile:1

#
# Dependencies stage
#
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

#
# Build stage
#
FROM deps AS build
COPY . .
RUN npm run build

#
# Runtime stage
#
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node config ./config

EXPOSE 8080

USER node

CMD ["node", "dist/server.js"]
```
