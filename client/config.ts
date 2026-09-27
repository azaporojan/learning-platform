// API Configuration
// '/api' in production (same origin); e.g. http://localhost:3001/api in local dev.
export const API_URL = import.meta.env.VITE_API_URL ?? '/api';
// Empty in production: the client is served by the API server, so Socket.IO connects to the same origin.
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || undefined;

// Helper function for API calls
export const apiUrl = (endpoint: string) => `${API_URL}${endpoint}`;

// Helper function to get full URL for uploaded files (avatars, images, etc.)
export const getFileUrl = (path: string | null | undefined): string | null => {
  if (!path) return null;
  // If already a full URL, return as is
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  // If relative path, prepend API_URL
  return `${API_URL}${path}`;
};
