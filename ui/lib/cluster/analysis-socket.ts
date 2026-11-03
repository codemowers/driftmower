import { io, type Socket } from "socket.io-client"

let socket: Socket | null = null

export function getAnalysisSocket(): Socket {
  if (!socket) {
    socket = io({ transports: ["polling", "websocket"] })
  }

  return socket
}

export function waitForSocketConnect(socket: Socket, timeoutMs?: number): Promise<void> {
  if (socket.connected) return Promise.resolve()
  return new Promise((resolve) => {
    socket.once("connect", () => resolve())
    if (timeoutMs != null) setTimeout(resolve, timeoutMs)
  })
}
