import { createServer } from 'node:http'
import { createFakeBackend } from './fake-backend.js'

// Local-only fixture service. The token matches the deliberately public test
// fixture token; this is not a production credential or backend replacement.
const backend = createFakeBackend()
const server = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200)
    response.end('ok')

    return
  }

  if (request.method !== 'GET') {
    response.writeHead(405)
    response.end()

    return
  }

  void backend
    .fetch(`http://driftmower-be:3030${request.url}`, {
      headers: { authorization: request.headers.authorization ?? '' }
    })
    .then(async result => {
      response.writeHead(result.status, { 'content-type': 'application/json' })
      response.end(await result.text())
    })
})

server.listen(3030, '::')
process.once('SIGTERM', () => server.close())
