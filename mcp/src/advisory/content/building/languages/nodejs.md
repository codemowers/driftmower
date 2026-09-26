# Building Node.js containers

- Use a pinned Node version shared across build stages. Install dependencies with the lockfile during the build, exclude npm credentials, and omit development-only packages from production.
- Launch production containers directly with exec-form `CMD ["node", "server.js"]` (or the application's built entry file). Avoid `npm start`, `npm run`, `npx`, and package-manager wrappers as production entrypoints. They add a process layer and can invoke lifecycle hooks or package resolution/download behavior, depending on the command and configuration. Runtime startup must not install dependencies or compile assets.
- Package managers remain appropriate for dependency installation, builds, tests, and interactive local development. A package.json `start` script is not itself a finding if the production container launches Node directly.
- Handle SIGTERM in the application; do not add dumb-init or a process supervisor by default. See `building/general` for runtime identity and the documented legacy-port exception.

TODO: Detailed dependency installation, compilation, and runtime-image selection examples.
