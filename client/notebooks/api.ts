import { apiUrl } from '../config';

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, message: string, data: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// JSON fetch against the platform API with the session cookie; throws ApiError with the server's message.
export async function api<T = any>(path: string, opts: { method?: string; json?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: opts.method || (opts.json !== undefined || opts.form ? 'POST' : 'GET'),
    credentials: 'include',
    headers: opts.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.form || (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
    signal: opts.signal,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data);
  return data as T;
}

// Notebook images are stored as /api/notebook-files/<id>; in local dev the API lives elsewhere.
export const notebookFileSrc = (src?: string) => (src && src.startsWith('/api/') ? apiUrl(src.slice(4)) : src);

export const newCellId = () => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const newRequestId = () => newCellId() + newCellId();

export const timeAgo = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
};
