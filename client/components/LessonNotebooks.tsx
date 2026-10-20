import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Notebook, NotebookSummary } from '../notebooks/types';
import { api } from '../notebooks/api';

// Notebooks attached to a lesson, inside the lesson view. Students open the teacher's notebook
// or their own copy of it; teachers add new ones.
export const LessonNotebooks: React.FC<{ lessonId: number; isAdmin: boolean; locked: boolean }> = ({ lessonId, isAdmin, locked }) => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<NotebookSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<NotebookSummary[]>(`/lessons/${lessonId}/notebooks`)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [lessonId]);

  const copyAndOpen = async (id: number) => {
    try {
      const copy = await api<Notebook>(`/notebooks/${id}/copy`, { method: 'POST' });
      navigate(`/notebooks/${copy.id}`);
    } catch (e) { setError((e as Error).message); }
  };

  const createForLesson = async () => {
    try {
      const nb = await api<Notebook>('/notebooks', { json: { title: 'New lesson notebook', lessonId } });
      navigate(`/notebooks/${nb.id}`);
    } catch (e) { setError((e as Error).message); }
  };

  if (rows === null) return null;
  if (rows.length === 0 && !isAdmin) return null;

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1">
          <span aria-hidden="true" className="material-icons text-base">menu_book</span>Notebooks
        </h3>
        {isAdmin && (
          <button type="button" onClick={createForLesson} className="text-sm font-bold text-primary-dark hover:underline inline-flex items-center gap-0.5">
            <span aria-hidden="true" className="material-icons text-base">add</span>New notebook
          </button>
        )}
      </div>
      {error && <p className="text-sm text-rose-600 mb-2">{error}</p>}
      {rows.length === 0 && <p className="text-sm text-gray-400">No notebook for this lesson yet.</p>}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 px-3 py-2">
            <div className="min-w-0">
              <div className="font-bold text-gray-800 truncate">{r.title}</div>
              <div className="text-xs text-gray-500">
                {r.code_cell_count} code · {r.cell_count - r.code_cell_count} text
                {isAdmin && !r.published && ' · draft, students cannot see it'}
                {isAdmin && r.copies_count ? ` · ${r.copies_count} student ${r.copies_count === 1 ? 'copy' : 'copies'}` : ''}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              {locked && !isAdmin ? (
                <span className="text-xs text-gray-400 inline-flex items-center gap-1"><span aria-hidden="true" className="material-icons text-sm">lock</span>Locked</span>
              ) : (
                <>
                  <button type="button" onClick={() => navigate(`/notebooks/${r.id}`)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-bold hover:border-primary-dark">Open</button>
                  {!isAdmin && (r.my_copy_id
                    ? <button type="button" onClick={() => navigate(`/notebooks/${r.my_copy_id}`)} className="px-3 py-1.5 rounded-lg bg-primary text-sm font-bold text-gray-900 hover:bg-primary-dark hover:text-white">Your copy</button>
                    : <button type="button" onClick={() => copyAndOpen(r.id)} className="px-3 py-1.5 rounded-lg bg-primary text-sm font-bold text-gray-900 hover:bg-primary-dark hover:text-white">Copy &amp; run</button>)}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};
