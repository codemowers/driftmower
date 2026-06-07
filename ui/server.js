const { createServer } = require("http")
const http = require("http")
const https = require("https")
const dns = require("dns")
const { URL } = require("url")
const nextEnv = require("@next/env")
const next = require("next")
const httpProxy = require("http-proxy-3")

const dev = process.env.NODE_ENV !== "production"
nextEnv.loadEnvConfig(process.cwd(), dev)

const port = parseInt(process.env.PORT || "3000", 10)
const hostname = process.env.HOSTNAME || "::"
const backendUrl = process.env.BACKEND_URL || "http://driftmower-be:3030"

const SOCKET_PATH = "/socket.io"

function freshLookup(host, options, callback) {
  dns.lookup(host, options, callback)
}

const isHttps = new URL(backendUrl).protocol === "https:"
const agentOptions = { keepAlive: false, lookup: freshLookup }
const agent = isHttps ? new https.Agent(agentOptions) : new http.Agent(agentOptions)

const proxy = httpProxy.createProxyServer({
  target: backendUrl,
  ws: true,
  changeOrigin: true,
  secure: true,
  agent,
})

proxy.on("error", (err, _req, res) => {
  console.error(`socket.io proxy error -> ${backendUrl}:`, err.message)
  if (res && typeof res.end === "function") res.end()
})

const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const upgrade = app.getUpgradeHandler()

  const server = createServer((req, res) => {
    if (req.url.startsWith(SOCKET_PATH)) {
      proxy.web(req, res)
      return
    }
    handle(req, res)
  })

  server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(SOCKET_PATH)) {
      socket.on("error", () => {})
      proxy.ws(req, socket, head)
      return
    }
    upgrade(req, socket, head)
  })

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port} (${dev ? "development" : "production"})`)
    console.log(`> Proxying ${SOCKET_PATH} -> ${backendUrl}`)
  })
})
