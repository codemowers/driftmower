import { io, type Socket } from "socket.io-client"

let socket: Socket | null = null

export function getAnalysisSocket(): Socket {
  if (!socket) {
    socket = io({ transports: ["websocket"] })
  }
  return socket
}
