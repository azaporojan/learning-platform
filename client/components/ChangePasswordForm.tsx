import React, { useState } from 'react';
import { apiUrl } from '../config';

// "Change password" section of the profile dialog. The server checks the current password,
// applies the password policy (length, common/breached passwords) and signs out other devices.
export const ChangePasswordForm: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reset = () => { setCurrent(''); setNext(''); setConfirm(''); setError(null); };
  const tooLong = next.length > 256;
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSave = current.length > 0 && next.length >= 8 && !tooLong && next === confirm && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/me/password'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error || 'Could not change the password.'); return; }
      reset();
      setOpen(false);
      setDone(true);
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const input = 'w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 outline-none focus:ring-2 focus:ring-primary';

  if (!open) {
    return (
      <div className="mb-6 flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3">
        <div className="text-sm">
          <div className="font-bold text-gray-700 dark:text-gray-300">Password</div>
          <div className="text-gray-500 dark:text-gray-400">
            {done ? 'Changed. Other devices were signed out.' : 'Use a long, unique password you do not use anywhere else.'}
          </div>
        </div>
        <button type="button" onClick={() => { setOpen(true); setDone(false); }} className="px-4 py-2 rounded-lg text-sm font-bold bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 flex items-center gap-1">
          <span className="material-icons text-base">lock_reset</span>Change password
        </button>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold text-gray-700 dark:text-gray-300">Change password</div>
        <button type="button" onClick={() => setShow((s) => !s)} className="text-xs font-semibold text-gray-500 hover:text-gray-700 flex items-center gap-1">
          <span className="material-icons text-sm">{show ? 'visibility_off' : 'visibility'}</span>{show ? 'Hide' : 'Show'}
        </button>
      </div>
      <input type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} autoFocus />
      <input type={show ? 'text' : 'password'} autoComplete="new-password" placeholder="New password (at least 8 characters)" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
      <input type={show ? 'text' : 'password'} autoComplete="new-password" placeholder="Repeat the new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        A passphrase of a few unrelated words works well. Common passwords and passwords found in public data breaches are refused.
        Every other device you are signed in on will be signed out.
      </p>
      {tooLong && <div className="text-xs text-red-500">That password is too long (max 256 characters).</div>}
      {mismatch && <div className="text-xs text-red-500">The new passwords do not match.</div>}
      {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-900/30 dark:text-red-300 rounded-lg p-2">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => { reset(); setOpen(false); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
        <button type="button" onClick={save} disabled={!canSave} className="px-4 py-2 rounded-lg text-sm font-bold bg-primary hover:bg-primary-dark text-white disabled:opacity-50">
          {saving ? 'Saving…' : 'Change password'}
        </button>
      </div>
    </div>
  );
};
