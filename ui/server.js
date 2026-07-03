const { createServer } = require("http")
const nextEnv = require("@next/env")
const next = require("next")
const httpProxy = require("http-proxy-3")

const dev = process.env.NODE_ENV !== "production"
nextEnv.loadEnvConfig(process.cwd(), dev)

const port = parseInt(process.env.PORT || "3000", 10)
const hostname = process.env.HOSTNAME || "::"
const backendUrl = process.env.BACKEND_URL || "http://driftmower-be:3030"

const SOCKET_PATH = "/socket.io"

// Must match lib/auth/session.ts so we can unseal the same cookie.
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "driftmower_session"
const SESSION_SECRET = process.env.SESSION_SECRET

// iron-session is ESM-only; load it lazily for this CommonJS server.
let unsealData = null

function readCookie(cookieHeader, name) {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim()
    if (trimmed.startsWith(name + "=")) {
      return decodeURIComponent(trimmed.slice(name.length + 1))
    }
  }
  return null
}

// The browser can't set Authorization on a socket.io connection, so the
// bearer is unsealed from the session cookie and injected here.
async function injectAuthHeader(req) {
  if (!unsealData || !SESSION_SECRET) return
  const sealed = readCookie(req.headers.cookie, SESSION_COOKIE)
  if (!sealed) return
  try {
    const data = await unsealData(sealed, { password: SESSION_SECRET })
    if (data && data.accessToken) {
      req.headers.authorization = `Bearer ${data.accessToken}`
    }
  } catch {
    // Invalid/expired cookie: the socket stays anonymous.
  }
}

const proxy = httpProxy.createProxyServer({
  target: backendUrl,
  ws: true,
  changeOrigin: true,
  secure: true,
})

proxy.on("error", (err, _req, res) => {
  console.error(`socket.io proxy error -> ${backendUrl}:`, err.message)
  if (res && typeof res.end === "function") res.end()
})

const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(async () => {
  const ironSession = await import("iron-session")
  unsealData = ironSession.unsealData

  if (!SESSION_SECRET) {
    console.warn("> SESSION_SECRET is not set; socket.io connections will be unauthenticated")
  }

  const upgrade = app.getUpgradeHandler()

  const server = createServer((req, res) => {
    if (req.url.startsWith(SOCKET_PATH)) {
      injectAuthHeader(req).finally(() => proxy.web(req, res))
      return
    }
    handle(req, res)
  })

  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(SOCKET_PATH)) {
      socket.on("error", () => {})
      injectAuthHeader(req).finally(() => proxy.ws(req, socket, head))
      return
    }
    upgrade(req, socket, head)
  })

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port} (${dev ? "development" : "production"})`)
    console.log(`> Proxying ${SOCKET_PATH} -> ${backendUrl}`)
  })
})
