import { io, type Socket } from "socket.io-client"

let socket: Socket | null = null

export function getAnalysisSocket(): Socket {
  if (!socket) {
    socket = io({ transports: ["websocket"] })
    console.log("Socket initiated");
  }

  return socket
}

export function waitForSocketConnect(socket: Socket, timeoutMs?: number): Promise<void> {
  if (socket.connected) return Promise.resolve()
  return new Promise((resolve) => {
    socket.once("connect", () => {
      console.log("Socket connected")
      resolve()
    })
    if (timeoutMs != null) setTimeout(resolve, timeoutMs)
  })
}
