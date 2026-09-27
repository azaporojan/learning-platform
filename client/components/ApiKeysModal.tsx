import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { apiUrl } from '../config';
import { ConfirmDialog } from './ConfirmDialog';

interface ApiKey {
  id: number;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_by_name: string;
}

interface ApiKeysModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function ApiKeysModal({ isOpen, onClose }: ApiKeysModalProps) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState<{ isOpen: boolean; id?: number; name?: string }>({ isOpen: false });

  useEffect(() => {
    if (isOpen) {
      fetchKeys();
      setCreatedKey(null);
      setError(null);
    }
  }, [isOpen]);

  const fetchKeys = async () => {
    try {
      setLoading(true);
      const response = await fetch(apiUrl('/admin/api-keys'), { credentials: 'include' });
      if (response.ok) setKeys(await response.json());
    } catch (err) {
      console.error('Failed to fetch API keys:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newName.trim().length < 2) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(apiUrl('/admin/api-keys'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: newName.trim() })
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Failed to create API key');
        return;
      }
      setCreatedKey({ name: data.name, key: data.key });
      setCopied(false);
      setNewName('');
      await fetchKeys();
    } catch (err) {
      console.error('Failed to create API key:', err);
      setError('Failed to create API key');
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeConfirm.id) return;
    try {
      const response = await fetch(apiUrl(`/admin/api-keys/${revokeConfirm.id}`), {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!response.ok) {
        const data = await response.json();
        setError(data.error || 'Failed to revoke API key');
      }
      await fetchKeys();
    } catch (err) {
      console.error('Failed to revoke API key:', err);
    } finally {
      setRevokeConfirm({ isOpen: false });
    }
  };

  const formatDate = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <>
      <div className="fixed inset-0 bg-black/70 z-[150] flex items-center justify-center p-4" onClick={onClose}>
        <div
          className="bg-white dark:bg-gray-800 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-2xl flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
            <div>
              <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100">API Keys</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Keys let automation (e.g. an AI agent) use the admin API. Send them as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.
              </p>
            </div>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors">
              <span className="material-icons text-3xl">close</span>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* Create */}
            <form onSubmit={handleCreate} className="flex items-end gap-3">
              <div className="flex-1">
                <label htmlFor="api-key-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">New key name</label>
                <input
                  id="api-key-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Claude agent"
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent"
                />
              </div>
              <button
                type="submit"
                disabled={creating || newName.trim().length < 2}
                className="px-5 py-2 bg-primary hover:bg-primary-dark text-white font-semibold rounded-lg transition-colors disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create key'}
              </button>
            </form>

            {error && <p className="text-sm text-red-600">{error}</p>}

            {createdKey && (
              <div className="p-4 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700">
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                  Key "{createdKey.name}" created. Copy it now — it will not be shown again.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="flex-1 font-mono text-sm break-all px-3 py-2 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 border border-amber-200 dark:border-amber-800">
                    {createdKey.key}
                  </code>
                  <button type="button" onClick={handleCopy} className="px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium">
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            {/* List */}
            {loading ? (
              <div className="text-center py-8">
                <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
              </div>
            ) : keys.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No API keys yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Name</th>
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Prefix</th>
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Created</th>
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Last used</th>
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Status</th>
                      <th className="text-right py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.id} className="border-b border-gray-100 dark:border-gray-700/50">
                        <td className="py-3 px-4 text-gray-900 dark:text-white">
                          {k.name}
                          <div className="text-xs text-gray-500 dark:text-gray-400">by {k.created_by_name}</div>
                        </td>
                        <td className="py-3 px-4 font-mono text-sm text-gray-700 dark:text-gray-300">{k.key_prefix}…</td>
                        <td className="py-3 px-4 text-sm text-gray-700 dark:text-gray-300">{formatDate(k.created_at)}</td>
                        <td className="py-3 px-4 text-sm text-gray-700 dark:text-gray-300">{formatDate(k.last_used_at)}</td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${k.revoked_at ? 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300' : 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200'}`}>
                            {k.revoked_at ? 'Revoked' : 'Active'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          {!k.revoked_at && (
                            <button
                              type="button"
                              onClick={() => setRevokeConfirm({ isOpen: true, id: k.id, name: k.name })}
                              className="text-red-600 hover:text-red-700 text-sm font-medium"
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={revokeConfirm.isOpen}
        title="Revoke API key"
        message={`Revoke "${revokeConfirm.name}"? Anything using it will stop working immediately.`}
        confirmText="Revoke"
        variant="danger"
        onConfirm={handleRevoke}
        onCancel={() => setRevokeConfirm({ isOpen: false })}
      />
    </>,
    document.body
  );
}
