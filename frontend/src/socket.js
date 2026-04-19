import { io } from "socket.io-client";
export const socket = io("http://localhost:3001", { autoConnect: false });

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
