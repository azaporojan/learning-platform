import React, { useEffect, useState } from 'react';
import { LessonUnlocks } from '../types';
import { apiUrl } from '../config';

interface UnlockState {
  all: boolean;
  users: { id: number; name: string; email: string }[];
  students: { id: number; name: string; email: string }[];
}

type Choice = 'road' | 'all' | 'some';

interface LessonUnlockPanelProps {
  lessonId: number;
  summary?: LessonUnlocks; // from the course road (who it is open for right now)
  onChanged: () => void;
}

// One line of English for who a lesson is opened early for.
export const unlockSummaryText = (u: LessonUnlocks | undefined): string | null => {
  if (!u) return null;
  if (u.all) return 'Unlocked early for everyone';
  if (u.users.length === 0) return null;
  if (u.users.length <= 3) return `Unlocked early for ${u.users.map((x) => x.name).join(', ')}`;
  return `Unlocked early for ${u.users.length} students`;
};

// Admin: open a lesson before the road reaches it — for every student of the course or for
// chosen ones. The students are told; the lesson's "finish the previous step first" gate (and
// its phase's) is skipped for them. Enrolment and star gates still apply.
export const LessonUnlockPanel: React.FC<LessonUnlockPanelProps> = ({ lessonId, summary, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<UnlockState | null>(null);
  const [choice, setChoice] = useState<Choice>('road');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setState(null);
    fetch(apiUrl(`/lessons/${lessonId}/unlocks`), { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load who this lesson is open for');
        return res.json() as Promise<UnlockState>;
      })
      .then((data) => {
        if (cancelled) return;
        setState(data);
        setChoice(data.all ? 'all' : data.users.length > 0 ? 'some' : 'road');
        setPicked(new Set(data.users.map((u) => u.id)));
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [open, lessonId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = choice === 'all' ? { all: true, userIds: [] } : choice === 'some' ? { all: false, userIds: [...picked] } : { all: false, userIds: [] };
      const res = await fetch(apiUrl(`/lessons/${lessonId}/unlocks`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save');
      onChanged();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const toggle = (id: number) => setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const summaryText = unlockSummaryText(summary);
  const choiceClass = (c: Choice) => `flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${choice === c ? 'border-primary bg-primary/5' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'}`;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-6 mt-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h4 className="text-sm font-bold text-gray-500">ACCESS</h4>
          <p className={`text-sm mt-1 ${summaryText ? 'text-amber-700 dark:text-amber-300 font-semibold' : 'text-gray-500 dark:text-gray-400'}`}>
            {summaryText ? <><span className="material-icons text-base align-text-bottom mr-1">lock_open</span>{summaryText}</> : 'Follows the road: students reach it once the previous steps are done.'}
          </p>
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className="flex-shrink-0 px-4 py-2 rounded-lg text-sm font-bold bg-amber-500 hover:bg-amber-600 text-white flex items-center gap-1">
            <span className="material-icons text-base">lock_open</span>{summaryText ? 'Change' : 'Unlock early'}
          </button>
        )}
      </div>

      {open && (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-900">
          {error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>}
          {!state && !error && <p className="text-sm text-gray-400">Loading…</p>}
          {state && (
            <div className="space-y-2">
              <label className={choiceClass('road')}>
                <input type="radio" name={`unlock-${lessonId}`} checked={choice === 'road'} onChange={() => setChoice('road')} className="mt-1" />
                <span>
                  <span className="block font-bold text-gray-800 dark:text-gray-100">Follow the road</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">Opens when the previous lesson's mandatory tasks are approved (and the phase is reached).</span>
                </span>
              </label>
              <label className={choiceClass('all')}>
                <input type="radio" name={`unlock-${lessonId}`} checked={choice === 'all'} onChange={() => setChoice('all')} className="mt-1" />
                <span>
                  <span className="block font-bold text-gray-800 dark:text-gray-100">Unlock for everyone</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">Every student of the course can start this lesson now ({state.students.length} enrolled).</span>
                </span>
              </label>
              <label className={choiceClass('some')}>
                <input type="radio" name={`unlock-${lessonId}`} checked={choice === 'some'} onChange={() => setChoice('some')} className="mt-1" />
                <span className="flex-1 min-w-0">
                  <span className="block font-bold text-gray-800 dark:text-gray-100">Unlock for chosen students</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">Only the students ticked below.</span>
                </span>
              </label>
              {choice === 'some' && (
                <div className="ml-8 max-h-56 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 divide-y divide-gray-100 dark:divide-gray-700">
                  {state.students.length === 0 && <p className="p-3 text-sm text-gray-400 italic">No students are enrolled in this course yet.</p>}
                  {state.students.map((u) => (
                    <label key={u.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <input type="checkbox" checked={picked.has(u.id)} onChange={() => toggle(u.id)} />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{u.name}</span>
                        <span className="block text-xs text-gray-500 truncate">{u.email}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400 pt-1">Students who gain access are notified. Enrolment and star requirements still apply.</p>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setOpen(false)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
                <button type="button" onClick={save} disabled={saving || (choice === 'some' && picked.size === 0)} className="px-4 py-2 rounded-lg text-sm font-bold bg-primary hover:bg-primary-dark text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
