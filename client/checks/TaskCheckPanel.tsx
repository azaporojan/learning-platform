import React, { useEffect, useRef, useState } from 'react';
import { api } from '../notebooks/api';
import { CodeFile, CheckResult, TaskCheckConfig } from './types';
import { CheckResultView } from './CheckResult';
import { FileTabsEditor } from './FileTabsEditor';

const draftKey = (taskId: number) => `task-code-draft-${taskId}`;
const readDraft = (taskId: number): CodeFile[] | null => {
  try { const v = localStorage.getItem(draftKey(taskId)); return v ? JSON.parse(v) : null; } catch { return null; }
};
const writeDraft = (taskId: number, files: CodeFile[]) => { try { localStorage.setItem(draftKey(taskId), JSON.stringify(files)); } catch { /* ignore */ } };

// Student side of an auto-checked task: write the code, check it against the hidden tests as
// often as you like, then submit it for review.
const TaskCheckPanel: React.FC<{ taskId: number; lastFiles?: CodeFile[] | null; onSubmitted: () => void }> = ({ taskId, lastFiles, onSubmitted }) => {
  const [config, setConfig] = useState<TaskCheckConfig | null>(null);
  const [files, setFiles] = useState<CodeFile[]>([]);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState<'check' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const loaded = useRef(false);
  const resultRef = useRef<HTMLDivElement>(null);

  // The result sits below the editor and the buttons: bring a finished one into view
  useEffect(() => {
    if (result && result.status !== 'running') resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [result]);

  useEffect(() => {
    let cancelled = false;
    api<TaskCheckConfig>(`/tasks/${taskId}/check`).then((c) => {
      if (cancelled) return;
      setConfig(c);
      if (!loaded.current) {
        loaded.current = true;
        // Your unsent draft first, then what you submitted last, then the teacher's starter
        const start = readDraft(taskId) || (lastFiles && lastFiles.length ? lastFiles : null) || (c.starter && c.starter.length ? c.starter : [{ path: 'Main.java', content: '' }]);
        setFiles(start);
      }
    }).catch(() => { if (!cancelled) setConfig({ enabled: false }); });
    return () => { cancelled = true; };
  }, [taskId, lastFiles]);

  const change = (next: CodeFile[]) => { setFiles(next); writeDraft(taskId, next); };

  const check = async () => {
    setBusy('check'); setError(null); setResult({ status: 'running', summary: 'Checking your code against the tests…', diagnostics: null, tests: null });
    try { setResult(await api<CheckResult>(`/tasks/${taskId}/check/try`, { json: { files } })); }
    catch (e) { setResult(null); setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const submit = async () => {
    setBusy('submit'); setError(null);
    try {
      await api(`/tasks/${taskId}/submit-code`, { json: { files, comment } });
      setComment('');
      try { localStorage.removeItem(draftKey(taskId)); } catch { /* ignore */ }
      onSubmitted();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const resetToStarter = () => { if (config?.starter?.length) change(config.starter); };

  if (!config || !config.enabled) return null;
  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <span className="text-sm font-bold text-gray-500 dark:text-gray-400 flex items-center gap-1">
          <span aria-hidden="true" className="material-icons text-base">science</span>YOUR CODE · CHECKED AUTOMATICALLY
        </span>
        {config.starter && config.starter.length > 0 && (
          <button type="button" onClick={resetToStarter} className="text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100">Reset to the starter code</button>
        )}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Hidden tests check your files. <strong>Check</strong> as often as you like: it only shows the result.
        <strong> Submit</strong> sends the code for review{config.auto_approve ? ', and it is approved automatically when every test passes' : ''}.
        Each check gets {config.timeout_s || 30} s.
      </p>
      <FileTabsEditor files={files} onChange={change} allowStructure newFileName="Main.java" />
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        maxLength={4000}
        placeholder="Optional note for the reviewer"
        className="w-full mt-3 p-3 rounded-xl border border-gray-200 dark:border-gray-700 text-sm focus:ring-2 focus:ring-primary outline-none resize-y bg-white dark:bg-gray-900 dark:text-gray-100"
      />
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <button type="button" onClick={check} disabled={busy !== null || files.length === 0} className="px-4 py-2 rounded-lg border-2 border-gray-200 dark:border-gray-700 font-bold text-gray-700 dark:text-gray-200 hover:border-primary-dark disabled:opacity-50 inline-flex items-center gap-1">
          <span aria-hidden="true" className={`material-icons text-[20px] ${busy === 'check' ? 'animate-spin' : ''}`}>{busy === 'check' ? 'refresh' : 'play_arrow'}</span>Check my code
        </button>
        <button type="button" onClick={submit} disabled={busy !== null || files.length === 0} className="px-5 py-2 rounded-lg bg-primary font-bold text-gray-900 hover:bg-primary-dark hover:text-white disabled:opacity-50 inline-flex items-center gap-1 shadow">
          <span aria-hidden="true" className="material-icons text-[20px]">send</span>{busy === 'submit' ? 'Submitting…' : 'Submit code'}
        </button>
      </div>
      {error && <p className="text-sm text-rose-600 dark:text-rose-400 mt-2">{error}</p>}
      {result && <div ref={resultRef} className="mt-3" aria-live="polite"><CheckResultView result={result} /></div>}
    </div>
  );
};

export default TaskCheckPanel;
