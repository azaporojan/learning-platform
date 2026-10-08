import { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config';

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
}

const SocketContext = createContext<SocketContextType>({
  socket: null,
  isConnected: false
});

export const useSocket = () => useContext(SocketContext);

interface SocketProviderProps {
  children: ReactNode;
  userId: number | null;
}

export const SocketProvider = ({ children, userId }: SocketProviderProps) => {
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!userId) {
      // User not logged in, disconnect if connected
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setIsConnected(false);
      return;
    }
    
    // Connect to Socket.IO server
    const socket = io(SOCKET_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling']
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      // Emit that this user is online
      socket.emit('user_online', userId);
      
      // Request current online users list
      socket.emit('request_online_users');
    });

    socket.on('disconnect', (reason) => {
      setIsConnected(false);
      // The server drops every socket of a user whose password just changed. This device holds
      // the fresh cookie, so it reconnects; other devices fail the handshake and stay offline.
      if (reason === 'io server disconnect') socket.connect();
    });

    socket.on('connect_error', (error) => {
      console.error('[Socket.IO] Connection error:', error);
      setIsConnected(false);
    });

    // Cleanup on unmount or when userId changes
    return () => {
      if (socket) {
        socket.disconnect();
      }
    };
  }, [userId]);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, isConnected }}>
      {children}
    </SocketContext.Provider>
  );
};

