import React, { useEffect, useState } from 'react';
import { api } from '../notebooks/api';
import { Modal } from '../notebooks/Modal';
import { SubmissionCheck } from './types';
import { CheckResultView } from './CheckResult';
import { FileTabsEditor } from './FileTabsEditor';

// A submission's code and its check, for the student who sent it and for teachers
const CheckDetails: React.FC<{ submissionId: number; isAdmin: boolean; onClose: () => void }> = ({ submissionId, isAdmin, onClose }) => {
  const [check, setCheck] = useState<SubmissionCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<SubmissionCheck>(`/submissions/${submissionId}/check`).then(setCheck).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [submissionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!check || check.status !== 'running') return undefined;
    const t = window.setTimeout(load, 1500);
    return () => window.clearTimeout(t);
  }, [check]); // eslint-disable-line react-hooks/exhaustive-deps

  const recheck = async () => {
    try { await api(`/submissions/${submissionId}/recheck`, { method: 'POST' }); load(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <Modal title="Code check" onClose={onClose} wide>
      {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      {!check && !error && <p className="text-sm text-gray-400">Loading…</p>}
      {check && (
        <div className="space-y-4">
          <CheckResultView result={check.result || { status: check.status, summary: check.summary, diagnostics: null, tests: null }} />
          <FileTabsEditor files={check.files} readOnly />
          {isAdmin && (
            <div className="flex justify-end">
              <button type="button" onClick={recheck} disabled={check.status === 'running'} className="px-4 py-2 rounded-lg border-2 border-gray-200 dark:border-gray-700 font-bold text-gray-700 dark:text-gray-200 hover:border-primary-dark disabled:opacity-50">Check again</button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default CheckDetails;
