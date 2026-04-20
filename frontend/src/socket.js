import { io } from "socket.io-client";
import { API_BASE } from "./config";

export const socket = io(API_BASE, {
  autoConnect: false,
  transports: ["websocket"],
});

export function connectSocketWithToken(token) {
  // Ensure a fresh auth handshake (important after logout/login)
  if (socket.connected) socket.disconnect();
  socket.auth = { token };
  socket.connect();
}

export function disconnectSocket() {
  socket.disconnect();
  socket.auth = {};
}
