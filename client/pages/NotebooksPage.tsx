import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { User } from '../types';
import { NotebookSummary, Notebook } from '../notebooks/types';
import { api, timeAgo } from '../notebooks/api';
import { Modal } from '../notebooks/Modal';

type Scope = 'mine' | 'teacher' | 'students';
type Kind = '' | 'lesson' | 'playground';

// Notebooks: your own (copies and playgrounds), the teacher's published ones, and for teachers
// the students' notebooks. Each row says whether it belongs to a lesson or is a playground.
export const NotebooksPage: React.FC<{ currentUser: User }> = ({ currentUser }) => {
  const isAdmin = currentUser.role === 'admin';
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const scopes: { key: Scope; label: string }[] = isAdmin
    ? [{ key: 'mine', label: 'My notebooks' }, { key: 'students', label: "Students' notebooks" }]
    : [{ key: 'mine', label: 'My notebooks' }, { key: 'teacher', label: 'Teacher notebooks' }];
  const scope = (scopes.some((s) => s.key === params.get('scope')) ? params.get('scope') : 'mine') as Scope;
  const kind = (['lesson', 'playground'].includes(params.get('kind') || '') ? params.get('kind') : '') as Kind;
  const [q, setQ] = useState(params.get('q') || '');
  const [rows, setRows] = useState<NotebookSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  const fetchRows = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ scope });
      if (kind) qs.set('kind', kind);
      const term = params.get('q');
      if (term) qs.set('q', term);
      setRows(await api<NotebookSummary[]>(`/notebooks?${qs}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    }
  }, [scope, kind, params]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // Search as you type, a moment after the last key
  useEffect(() => {
    const t = window.setTimeout(() => { if ((params.get('q') || '') !== q.trim()) setParam('q', q.trim()); }, 300);
    return () => window.clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    const title = newTitle.trim();
    if (!title) return;
    setBusy(true);
    try {
      const nb = await api<Notebook>('/notebooks', { json: { title } });
      navigate(`/notebooks/${nb.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('notebook', file);
      const nb = await api<Notebook>('/notebooks/import', { form });
      navigate(`/notebooks/${nb.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="max-w-5xl mx-auto py-4">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
          <div>
            <h1 className="text-3xl font-extrabold text-gray-800">Notebooks</h1>
            <p className="text-gray-500 mt-1">Java you can run right here. {isAdmin ? 'Attach notebooks to lessons and publish them for students.' : "Copy the teacher's notebooks to try the code yourself, or start a playground."}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => importInput.current?.click()} disabled={busy} className="h-10 px-4 rounded-full border-2 border-gray-200 font-bold text-gray-700 hover:border-primary-dark inline-flex items-center gap-1">
              <span aria-hidden="true" className="material-icons text-[20px]">upload_file</span>Import .md
            </button>
            <button type="button" onClick={() => { setNewTitle(''); setCreating(true); }} className="h-10 px-4 rounded-full bg-primary font-bold text-gray-900 hover:bg-primary-dark hover:text-white inline-flex items-center gap-1">
              <span aria-hidden="true" className="material-icons text-[20px]">add</span>New notebook
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="flex rounded-xl bg-gray-100 p-1" role="tablist">
            {scopes.map((s) => (
              <button key={s.key} role="tab" aria-selected={scope === s.key} type="button" onClick={() => setParam('scope', s.key === 'mine' ? '' : s.key)}
                className={`px-4 py-1.5 rounded-lg text-sm font-bold ${scope === s.key ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-800'}`}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {([['', 'All'], ['lesson', 'Lessons'], ['playground', 'Playgrounds']] as [Kind, string][]).map(([k, label]) => (
              <button key={k || 'all'} type="button" onClick={() => setParam('kind', k)}
                className={`px-3 py-1 rounded-full text-sm font-semibold border ${kind === k ? 'border-primary-dark bg-primary/20 text-gray-900' : 'border-gray-200 text-gray-500 hover:border-gray-400'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[200px]">
            <span aria-hidden="true" className="material-icons absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[20px]">search</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={isAdmin ? 'Title, lesson, course or student' : 'Title, lesson or course'} className="w-full pl-10 pr-3 py-2 rounded-xl border-gray-200 focus:border-primary-dark focus:ring-primary-dark" aria-label="Search notebooks" />
          </div>
        </div>

        {error && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-2 text-sm text-rose-800">{error}</div>}
        {rows === null && <p className="text-gray-400 py-10 text-center">Loading…</p>}
        {rows && rows.length === 0 && (
          <div className="text-center py-16 rounded-2xl border-2 border-dashed border-gray-200">
            <span aria-hidden="true" className="material-icons text-4xl text-gray-300">menu_book</span>
            <p className="text-gray-500 mt-2">
              {params.get('q') ? 'No notebook matches that search.' : scope === 'mine' ? 'No notebooks yet. Start one, or copy a lesson notebook.' : scope === 'teacher' ? 'The teacher has not published notebooks yet.' : 'No student notebooks yet.'}
            </p>
          </div>
        )}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white">
            {rows.map((r) => (
              <li key={r.id}>
                <Link to={r.locked ? '#' : `/notebooks/${r.id}`} onClick={(e) => { if (r.locked) e.preventDefault(); }}
                  className={`flex items-center gap-4 px-4 py-3 ${r.locked ? 'opacity-60 cursor-not-allowed' : 'hover:bg-gray-50'}`}>
                  <span aria-hidden="true" className={`material-icons shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${r.kind === 'lesson' ? 'bg-lime-100 text-lime-800' : 'bg-sky-100 text-sky-800'}`}>
                    {r.locked ? 'lock' : r.kind === 'lesson' ? 'school' : 'science'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-gray-800 truncate">{r.title}</span>
                      {isAdmin && r.owner.is_teacher && !r.published && <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 border border-gray-200 rounded px-1.5">Draft</span>}
                      {r.copied_from && r.copied_from.updated_since_copy && <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 rounded px-1.5">Updated original</span>}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {r.lesson ? `${r.lesson.course_name ? `${r.lesson.course_name} › ` : ''}${r.lesson.title}` : 'Playground'}
                      {scope !== 'mine' && ` · ${r.owner.name}`}
                      {r.copied_from && !r.copied_from.removed && r.copied_from.title && ` · copy of ${r.copied_from.title}`}
                      {r.locked && ' · lesson not reached yet'}
                    </div>
                  </div>
                  <div className="hidden sm:block text-right text-xs text-gray-500 shrink-0 tabular-nums">
                    <div>{r.code_cell_count} code · {r.cell_count - r.code_cell_count} text</div>
                    <div>{r.last_run_at ? `ran ${timeAgo(r.last_run_at)}` : `edited ${timeAgo(r.updated_at)}`}</div>
                    {isAdmin && r.owner.is_teacher && r.copies_count ? <div>{r.copies_count} student {r.copies_count === 1 ? 'copy' : 'copies'}</div> : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <input ref={importInput} type="file" accept=".md,.markdown,.txt,text/markdown" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f); }} />

      {creating && (
        <Modal title="New notebook" onClose={() => setCreating(false)}>
          <form onSubmit={(e) => { e.preventDefault(); create(); }} className="space-y-4">
            <label className="block">
              <span className="text-sm font-bold text-gray-700">Title</span>
              <input id="new-notebook-title" autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} maxLength={255} placeholder={isAdmin ? 'Streams: filter, map, collect' : 'My playground'} className="mt-1 w-full rounded-lg border-gray-300 focus:border-primary-dark focus:ring-primary-dark" />
            </label>
            <p className="text-xs text-gray-500">{isAdmin ? 'It starts as a draft playground; attach it to a lesson and publish it from its settings.' : 'A playground is yours only.'}</p>
            <div className="flex justify-end">
              <button type="submit" disabled={!newTitle.trim() || busy} className="px-5 py-2 rounded-full bg-primary font-bold text-gray-900 hover:bg-primary-dark hover:text-white disabled:opacity-50">Create</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};
