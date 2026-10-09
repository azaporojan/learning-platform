import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FlashcardItem, QuizItem, QuizResult, RoadStudySet, StudySet, StudySetKind } from '../types';
import { apiUrl } from '../config';

// Open an existing set, or create a new one under a lesson (admin)
export type StudySetTarget =
  | { mode: 'open'; set: RoadStudySet }
  | { mode: 'create'; lessonId: number; lessonTitle: string; kind: StudySetKind };

interface StudySetModalProps {
  target: StudySetTarget | null;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
}

const KIND_LABEL: Record<StudySetKind, string> = { quiz: 'Quiz', flashcards: 'Flashcards' };
const KIND_ICON: Record<StudySetKind, string> = { quiz: 'quiz', flashcards: 'style' };

const emptyQuestion = (): QuizItem => ({ question: '', options: ['', ''], correct: [0], explanation: '' });
const emptyCard = (): FlashcardItem => ({ front: '', back: '' });

const Md: React.FC<{ children: string; className?: string }> = ({ children, className }) => (
  <div className={`prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:bg-gray-900 prose-pre:text-gray-100 ${className || ''}`}>
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
  </div>
);

function shuffled<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A quiz or a flashcard deck: students practise; admins edit (form or raw JSON), preview, delete.
export const StudySetModal: React.FC<StudySetModalProps> = ({ target, isAdmin, onClose, onChanged }) => {
  const [set, setSet] = useState<StudySet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'practice' | 'edit' | 'delete'>('practice');
  const [busy, setBusy] = useState(false);

  const kind: StudySetKind | null = target ? (target.mode === 'open' ? target.set.kind : target.kind) : null;

  const load = useCallback(async (id: number) => {
    setError(null);
    const res = await fetch(apiUrl(`/study-sets/${id}`), { credentials: 'include' });
    const body = await res.json().catch(() => null);
    if (!res.ok) { setError(body?.error || 'Could not load this set.'); return; }
    setSet(body);
  }, []);

  useEffect(() => {
    setSet(null);
    setError(null);
    if (!target) return;
    if (target.mode === 'create') { setMode('edit'); return; }
    setMode(isAdmin ? 'edit' : 'practice');
    load(target.set.id);
  }, [target, isAdmin, load]);

  if (!target || !kind) return null;

  const title = target.mode === 'create' ? `New ${KIND_LABEL[kind].toLowerCase()}` : (set?.title || target.set.title);
  const close = () => { if (!busy) onClose(); };

  const remove = async () => {
    if (!set) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/study-sets/${set.id}`), { method: 'DELETE', credentials: 'include' });
      if (res.ok) { onChanged(); onClose(); } else setError('Could not delete this set.');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={close}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[900px] max-w-[95vw] max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3">
          <span className={`material-icons ${kind === 'quiz' ? 'text-purple-500' : 'text-pink-500'}`}>{KIND_ICON[kind]}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
              {KIND_LABEL[kind]}{target.mode === 'create' ? ` · ${target.lessonTitle}` : ''}
            </div>
            <h3 className="text-xl font-bold text-gray-800 dark:text-white truncate">{title}</h3>
          </div>
          {isAdmin && set && (
            <div className="flex rounded-lg bg-gray-100 dark:bg-gray-700 p-0.5 text-sm font-bold">
              {(['edit', 'practice'] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={`px-3 py-1 rounded-md ${mode === m ? 'bg-white dark:bg-gray-900 shadow text-gray-800 dark:text-white' : 'text-gray-500'}`}>
                  {m === 'edit' ? 'Edit' : 'Preview'}
                </button>
              ))}
            </div>
          )}
          <button onClick={close} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex-shrink-0">
            <span className="material-icons">close</span>
          </button>
        </div>

        {error && <div className="mx-6 mt-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm font-semibold dark:bg-red-900/30 dark:text-red-300">{error}</div>}

        {mode === 'delete' && set ? (
          <div className="p-8 flex flex-col items-center text-center">
            <span className="material-icons text-red-500 text-5xl mb-3">warning</span>
            <h4 className="text-xl font-bold text-gray-800 dark:text-white mb-2">Delete “{set.title}”?</h4>
            <p className="text-gray-600 dark:text-gray-300 max-w-md">Its {set.item_count} {kind === 'quiz' ? 'questions' : 'cards'} and every student result on it will be deleted.</p>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setMode('edit')} disabled={busy} className="px-5 py-2.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">Cancel</button>
              <button onClick={remove} disabled={busy} className="px-5 py-2.5 bg-red-500 hover:bg-red-600 text-white font-bold rounded-lg disabled:opacity-50">{busy ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        ) : mode === 'edit' && isAdmin ? (
          target.mode === 'create' || set ? (
            <StudySetEditor
              key={set?.id ?? 'new'}
              kind={kind}
              initial={set}
              busy={busy}
              setBusy={setBusy}
              onCancel={close}
              onDelete={set ? () => setMode('delete') : undefined}
              onSaved={async (saved) => {
                onChanged();
                if (target.mode === 'create') onClose();
                else { setSet((prev) => (prev ? { ...prev, ...saved } : saved)); await load(saved.id); }
              }}
              lessonId={target.mode === 'create' ? target.lessonId : set!.lesson_id}
            />
          ) : <Spinner />
        ) : set ? (
          set.items.length === 0 ? (
            <div className="p-10 text-center text-gray-400 font-semibold">This set has no {kind === 'quiz' ? 'questions' : 'cards'} yet.</div>
          ) : kind === 'quiz'
            ? <QuizPlayer key={set.updated_at} set={set} onRecorded={onChanged} />
            : <FlashcardPlayer key={set.updated_at} set={set} onRecorded={onChanged} />
        ) : !error ? <Spinner /> : null}
      </div>
    </div>
  );
};

const Spinner = () => (
  <div className="p-12 flex justify-center"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary" /></div>
);

// ---------------------------------------------------------------------------
// Quiz: answer every question, then the server grades it and returns the explanations.
// ---------------------------------------------------------------------------
const QuizPlayer: React.FC<{ set: StudySet; onRecorded: () => void }> = ({ set, onRecorded }) => {
  const items = set.items as QuizItem[];
  const [answers, setAnswers] = useState<number[][]>(() => items.map(() => []));
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<QuizResult[] | null>(null);
  const [score, setScore] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const multiple = (q: QuizItem) => q.multiple ?? (q.correct ? q.correct.length > 1 : false);
  const answered = answers.filter((a) => a.length > 0).length;

  const toggle = (qi: number, oi: number) => {
    if (results) return;
    setAnswers((prev) => prev.map((a, i) => {
      if (i !== qi) return a;
      if (!multiple(items[qi])) return [oi];
      return a.includes(oi) ? a.filter((x) => x !== oi) : [...a, oi];
    }));
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/study-sets/${set.id}/attempts`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ answers }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error || 'Could not submit your answers.'); return; }
      setResults(body.results);
      setScore(body.score);
      onRecorded();
    } finally { setSubmitting(false); }
  };

  const restart = () => { setAnswers(items.map(() => [])); setResults(null); setIndex(0); };

  if (results) {
    const pct = Math.round((score / items.length) * 100);
    return (
      <>
        <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-4">
          <div className={`rounded-2xl p-5 text-center ${pct === 100 ? 'bg-green-50 dark:bg-green-900/30' : pct >= 60 ? 'bg-primary/10' : 'bg-amber-50 dark:bg-amber-900/20'}`}>
            <div className="text-4xl font-black text-gray-800 dark:text-white">{score} / {items.length}</div>
            <div className="text-sm font-semibold text-gray-500 mt-1">{pct === 100 ? 'Perfect — well done!' : pct >= 60 ? 'Good — review the misses below.' : 'Keep practising — the explanations below help.'}</div>
          </div>
          {items.map((q, qi) => {
            const r = results[qi];
            return (
              <div key={qi} className={`rounded-xl border-2 p-4 ${r.correct ? 'border-green-300 dark:border-green-800' : 'border-red-300 dark:border-red-800'}`}>
                <div className="flex items-start gap-2">
                  <span className={`material-icons ${r.correct ? 'text-green-500' : 'text-red-500'}`}>{r.correct ? 'check_circle' : 'cancel'}</span>
                  <div className="flex-1 min-w-0">
                    <Md className="font-semibold">{q.question}</Md>
                    <ul className="mt-2 space-y-1">
                      {q.options.map((o, oi) => {
                        const isCorrect = r.correct_options.includes(oi);
                        const picked = r.selected.includes(oi);
                        return (
                          <li key={oi} className={`flex items-start gap-2 rounded-lg px-3 py-1.5 text-sm ${isCorrect ? 'bg-green-50 dark:bg-green-900/30' : picked ? 'bg-red-50 dark:bg-red-900/30' : ''}`}>
                            <span className={`material-icons text-base ${isCorrect ? 'text-green-600' : picked ? 'text-red-500' : 'text-gray-300'}`}>
                              {isCorrect ? 'check' : picked ? 'close' : 'radio_button_unchecked'}
                            </span>
                            <Md>{o}</Md>
                          </li>
                        );
                      })}
                    </ul>
                    {r.explanation && (
                      <div className="mt-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-sm">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-blue-500">Why</span>
                        <Md>{r.explanation}</Md>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end">
          <button onClick={restart} className="px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-lg flex items-center gap-1">
            <span className="material-icons text-base">replay</span>Try again
          </button>
        </div>
      </>
    );
  }

  const q = items[index];
  const last = index === items.length - 1;
  return (
    <>
      <div className="px-6 pt-4">
        <div className="flex items-center justify-between text-xs font-bold text-gray-500 mb-1.5">
          <span>Question {index + 1} of {items.length}</span>
          <span>{answered} answered{set.progress && set.progress.total === items.length ? ` · best ${set.progress.best_score}/${set.progress.total}` : ''}</span>
        </div>
        <div className="flex gap-1">
          {items.map((_, i) => (
            <button key={i} onClick={() => setIndex(i)} title={`Question ${i + 1}`}
              className={`h-1.5 flex-1 rounded-full ${i === index ? 'bg-purple-600' : answers[i].length > 0 ? 'bg-purple-300' : 'bg-gray-200 dark:bg-gray-700'}`} />
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
        <Md className="prose-base font-semibold text-gray-800 dark:text-gray-100">{q.question}</Md>
        {multiple(q) && <div className="text-xs font-bold text-purple-600 mt-1">Select all that apply</div>}
        <div className="mt-4 space-y-2">
          {q.options.map((o, oi) => {
            const picked = answers[index].includes(oi);
            return (
              <button key={oi} type="button" onClick={() => toggle(index, oi)}
                className={`w-full flex items-center gap-3 text-left rounded-xl border-2 px-4 py-3 transition-colors ${picked ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/30' : 'border-gray-200 dark:border-gray-700 hover:border-purple-300'}`}>
                <span className={`material-icons ${picked ? 'text-purple-600' : 'text-gray-300'}`}>
                  {multiple(q) ? (picked ? 'check_box' : 'check_box_outline_blank') : (picked ? 'radio_button_checked' : 'radio_button_unchecked')}
                </span>
                <Md className="flex-1">{o}</Md>
              </button>
            );
          })}
        </div>
        {error && <div className="mt-4 text-sm font-semibold text-red-600">{error}</div>}
      </div>
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <button onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} className="px-4 py-2 rounded-lg font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 flex items-center">
          <span className="material-icons">chevron_left</span>Back
        </button>
        {last ? (
          <button onClick={submit} disabled={submitting || answered === 0} className="px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-lg disabled:opacity-50">
            {submitting ? 'Checking…' : answered < items.length ? `Check answers (${items.length - answered} blank)` : 'Check answers'}
          </button>
        ) : (
          <button onClick={() => setIndex((i) => i + 1)} className="px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-lg flex items-center">
            Next<span className="material-icons">chevron_right</span>
          </button>
        )}
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Flashcards: flip, then "Got it" or "Again" (the card comes back at the end of the round).
// The score is the number of cards known on first sight.
// ---------------------------------------------------------------------------
const FlashcardPlayer: React.FC<{ set: StudySet; onRecorded: () => void }> = ({ set, onRecorded }) => {
  const cards = set.items as FlashcardItem[];
  const [queue, setQueue] = useState<number[]>(() => cards.map((_, i) => i));
  const [flipped, setFlipped] = useState(false);
  const [seen, setSeen] = useState<Set<number>>(new Set());
  const [knownFirst, setKnownFirst] = useState(0);
  const [done, setDone] = useState(false);

  const start = (order: number[]) => { setQueue(order); setFlipped(false); setSeen(new Set()); setKnownFirst(0); setDone(false); };

  const answer = async (known: boolean) => {
    const current = queue[0];
    const firstSight = !seen.has(current);
    const nextKnown = knownFirst + (known && firstSight ? 1 : 0);
    setSeen((prev) => new Set(prev).add(current));
    setKnownFirst(nextKnown);
    const rest = known ? queue.slice(1) : [...queue.slice(1), current];
    setFlipped(false);
    if (rest.length === 0) {
      setDone(true);
      setQueue([]);
      try {
        await fetch(apiUrl(`/study-sets/${set.id}/attempts`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ known: nextKnown }),
        });
        onRecorded();
      } catch { /* the practice itself still counted for the student */ }
    } else {
      setQueue(rest);
    }
  };

  // Keyboard: space flips, → / ← answer once flipped
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (done || queue.length === 0) return;
      if (e.key === ' ') { e.preventDefault(); setFlipped((f) => !f); }
      else if (flipped && e.key === 'ArrowRight') answer(true);
      else if (flipped && e.key === 'ArrowLeft') answer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (done) {
    return (
      <div className="p-10 flex flex-col items-center text-center">
        <span className="material-icons text-6xl text-pink-500">emoji_events</span>
        <div className="text-3xl font-black text-gray-800 dark:text-white mt-2">{knownFirst} / {cards.length}</div>
        <div className="text-sm font-semibold text-gray-500 mt-1">known on first sight</div>
        <div className="flex gap-3 mt-6">
          <button onClick={() => start(cards.map((_, i) => i))} className="px-5 py-2.5 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 font-bold rounded-lg">Start over</button>
          <button onClick={() => start(shuffled(cards.map((_, i) => i)))} className="px-5 py-2.5 bg-pink-500 hover:bg-pink-600 text-white font-bold rounded-lg flex items-center gap-1">
            <span className="material-icons text-base">shuffle</span>Shuffle &amp; go
          </button>
        </div>
      </div>
    );
  }

  const card = cards[queue[0]];
  const learned = cards.length - queue.length;
  return (
    <>
      <div className="px-6 pt-4 flex items-center justify-between text-xs font-bold text-gray-500">
        <span>{learned} of {cards.length} learned · {queue.length} to go</span>
        <span className="flex items-center gap-3">
          {set.progress && set.progress.total === cards.length && <span>best {set.progress.best_score}/{set.progress.total}</span>}
          <button onClick={() => start(shuffled(cards.map((_, i) => i)))} className="flex items-center gap-1 text-pink-600 hover:underline">
            <span className="material-icons text-sm">shuffle</span>Shuffle
          </button>
        </span>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
        <button type="button" onClick={() => setFlipped((f) => !f)}
          className={`w-full min-h-[260px] rounded-2xl border-2 shadow-sm p-8 flex flex-col items-center justify-center text-center transition-colors ${flipped ? 'border-pink-400 bg-pink-50 dark:bg-pink-900/20' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-pink-300'}`}>
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-3">{flipped ? 'Answer' : 'Question'}</span>
          <Md className="prose-lg text-gray-800 dark:text-gray-100">{flipped ? card.back : card.front}</Md>
          {!flipped && <span className="mt-6 text-xs font-semibold text-gray-400">Click or press space to flip</span>}
        </button>
      </div>
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-center gap-3">
        {flipped ? (
          <>
            <button onClick={() => answer(false)} className="px-5 py-2.5 bg-amber-100 hover:bg-amber-200 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 font-bold rounded-lg flex items-center gap-1">
              <span className="material-icons text-base">replay</span>Again
            </button>
            <button onClick={() => answer(true)} className="px-5 py-2.5 bg-green-500 hover:bg-green-600 text-white font-bold rounded-lg flex items-center gap-1">
              <span className="material-icons text-base">check</span>Got it
            </button>
          </>
        ) : (
          <button onClick={() => setFlipped(true)} className="px-6 py-2.5 bg-pink-500 hover:bg-pink-600 text-white font-bold rounded-lg">Show answer</button>
        )}
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Admin editor: a form per item, or the raw JSON (handy for pasting what an assistant drafted).
// ---------------------------------------------------------------------------
interface EditorProps {
  kind: StudySetKind;
  initial: StudySet | null;
  lessonId: number;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onCancel: () => void;
  onDelete?: () => void;
  onSaved: (set: StudySet) => void;
}

const inputClass = 'w-full p-2.5 rounded-lg border border-gray-200 dark:border-gray-600 dark:bg-gray-700 outline-none focus:ring-2 focus:ring-primary text-sm';

const StudySetEditor: React.FC<EditorProps> = ({ kind, initial, lessonId, busy, setBusy, onCancel, onDelete, onSaved }) => {
  const [title, setTitle] = useState(initial?.title || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [items, setItems] = useState<Array<QuizItem | FlashcardItem>>(() =>
    initial ? initial.items.map((i) => ({ ...i })) : [kind === 'quiz' ? emptyQuestion() : emptyCard()]);
  const [jsonMode, setJsonMode] = useState(false);
  const [json, setJson] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const quizItems = items as QuizItem[];
  const cardItems = items as FlashcardItem[];
  const jsonExample = useMemo(() => (kind === 'quiz'
    ? '[{ "question": "…", "options": ["A", "B", "C"], "correct": 1, "explanation": "…" }]'
    : '[{ "front": "…", "back": "…" }]'), [kind]);

  const update = (i: number, patch: Partial<QuizItem & FlashcardItem>) => setItems((prev) => prev.map((it, k) => (k === i ? { ...it, ...patch } : it)));
  const move = (i: number, d: number) => setItems((prev) => {
    const j = i + d;
    if (j < 0 || j >= prev.length) return prev;
    const next = [...prev];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const toggleJson = () => {
    if (!jsonMode) { setJson(JSON.stringify(items, null, 2)); setJsonMode(true); setErrors([]); return; }
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) throw new Error('The JSON must be an array of items');
      setItems(parsed);
      setJsonMode(false);
      setErrors([]);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : 'Invalid JSON']);
    }
  };

  const save = async () => {
    let payloadItems: unknown = items;
    if (jsonMode) {
      try { payloadItems = JSON.parse(json); } catch (e) { setErrors([e instanceof Error ? e.message : 'Invalid JSON']); return; }
    }
    setBusy(true);
    setErrors([]);
    try {
      const body = { title: title.trim(), description, items: payloadItems };
      const res = initial
        ? await fetch(apiUrl(`/study-sets/${initial.id}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) })
        : await fetch(apiUrl('/study-sets'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ ...body, lessonId, kind }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setErrors(data?.details || [data?.error || 'Could not save.']); return; }
      onSaved(data);
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-1">Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'quiz' ? 'e.g. HTTP basics check' : 'e.g. Key terms'} className={inputClass} autoFocus={!initial} />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-1">Description <span className="font-normal text-gray-400">(optional)</span></label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
          </div>
        </div>

        <div className="flex items-center justify-between">
          <h4 className="text-sm font-bold text-gray-500">{kind === 'quiz' ? 'QUESTIONS' : 'CARDS'} ({jsonMode ? '…' : items.length})</h4>
          <button onClick={toggleJson} className="text-xs font-bold text-purple-600 hover:underline flex items-center gap-1">
            <span className="material-icons text-sm">{jsonMode ? 'view_list' : 'data_object'}</span>{jsonMode ? 'Back to the form' : 'Edit as JSON'}
          </button>
        </div>
        <p className="text-xs text-gray-400 -mt-2">Markdown is supported in every text field (`code`, **bold**, lists, code blocks).</p>

        {jsonMode ? (
          <div>
            <textarea value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} className={`${inputClass} font-mono text-xs min-h-[360px]`} />
            <p className="text-xs text-gray-400 mt-1">Format: <code>{jsonExample}</code>{kind === 'quiz' && ' — correct is a 0-based index, or an array of indexes for "select all that apply".'}</p>
          </div>
        ) : kind === 'quiz' ? (
          quizItems.map((q, i) => (
            <div key={i} className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-extrabold text-purple-600">Q{i + 1}</span>
                <div className="flex-1" />
                <ItemTools onUp={() => move(i, -1)} onDown={() => move(i, 1)} onRemove={() => setItems((prev) => prev.filter((_, k) => k !== i))} />
              </div>
              <textarea value={q.question} onChange={(e) => update(i, { question: e.target.value })} placeholder="Question" rows={2} className={inputClass} />
              <div className="space-y-1.5">
                {q.options.map((o, oi) => {
                  const correct = (q.correct || []).includes(oi);
                  return (
                    <div key={oi} className="flex items-center gap-2">
                      <button type="button" title={correct ? 'Correct answer' : 'Mark as correct'}
                        onClick={() => update(i, { correct: correct ? (q.correct || []).filter((c) => c !== oi) : [...(q.correct || []), oi].sort((a, b) => a - b) })}
                        className={`material-icons ${correct ? 'text-green-500' : 'text-gray-300 hover:text-green-400'}`}>
                        {correct ? 'check_circle' : 'radio_button_unchecked'}
                      </button>
                      <input value={o} onChange={(e) => update(i, { options: q.options.map((x, k) => (k === oi ? e.target.value : x)) })} placeholder={`Answer ${oi + 1}`} className={inputClass} />
                      <button type="button" disabled={q.options.length <= 2} title="Remove answer"
                        onClick={() => update(i, {
                          options: q.options.filter((_, k) => k !== oi),
                          correct: (q.correct || []).filter((c) => c !== oi).map((c) => (c > oi ? c - 1 : c)),
                        })}
                        className="material-icons text-gray-300 hover:text-red-500 disabled:opacity-30">remove_circle_outline</button>
                    </div>
                  );
                })}
                {q.options.length < 10 && (
                  <button type="button" onClick={() => update(i, { options: [...q.options, ''] })} className="text-xs font-bold text-gray-500 hover:text-purple-600 flex items-center gap-1 ml-8">
                    <span className="material-icons text-sm">add</span>Add answer
                  </button>
                )}
              </div>
              <input value={q.explanation || ''} onChange={(e) => update(i, { explanation: e.target.value })} placeholder="Explanation shown after checking (optional)" className={inputClass} />
            </div>
          ))
        ) : (
          cardItems.map((c, i) => (
            <div key={i} className="rounded-xl border border-gray-200 dark:border-gray-700 p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-extrabold text-pink-600">Card {i + 1}</span>
                <div className="flex-1" />
                <ItemTools onUp={() => move(i, -1)} onDown={() => move(i, 1)} onRemove={() => setItems((prev) => prev.filter((_, k) => k !== i))} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <textarea value={c.front} onChange={(e) => update(i, { front: e.target.value })} placeholder="Front (question / term)" rows={3} className={inputClass} />
                <textarea value={c.back} onChange={(e) => update(i, { back: e.target.value })} placeholder="Back (answer / definition)" rows={3} className={inputClass} />
              </div>
            </div>
          ))
        )}

        {!jsonMode && (
          <button type="button" onClick={() => setItems((prev) => [...prev, kind === 'quiz' ? emptyQuestion() : emptyCard()])}
            className="w-full flex items-center justify-center gap-1 rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 py-3 text-sm font-bold text-gray-500 hover:border-primary hover:text-primary-dark">
            <span className="material-icons text-base">add</span>{kind === 'quiz' ? 'Add question' : 'Add card'}
          </button>
        )}

        {errors.length > 0 && (
          <ul className="rounded-lg bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-700 dark:text-red-300 list-disc list-inside space-y-0.5">
            {errors.slice(0, 12).map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        )}
      </div>

      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
        {onDelete ? (
          <button onClick={onDelete} disabled={busy} className="px-4 py-2.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 font-bold rounded-lg flex items-center gap-1">
            <span className="material-icons text-base">delete</span>Delete
          </button>
        ) : <div />}
        <div className="flex gap-3">
          <button onClick={onCancel} disabled={busy} className="px-5 py-2.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">{initial ? 'Close' : 'Cancel'}</button>
          <button onClick={save} disabled={busy || !title.trim()} className="px-5 py-2.5 bg-primary hover:bg-primary-dark text-white font-bold rounded-lg shadow-md disabled:opacity-50">
            {busy ? 'Saving…' : initial ? 'Save changes' : `Create ${KIND_LABEL[kind].toLowerCase()}`}
          </button>
        </div>
      </div>
    </>
  );
};

const ItemTools: React.FC<{ onUp: () => void; onDown: () => void; onRemove: () => void }> = ({ onUp, onDown, onRemove }) => (
  <div className="flex items-center text-gray-400">
    <button type="button" onClick={onUp} title="Move up" className="material-icons text-lg hover:text-gray-700 dark:hover:text-gray-200">arrow_upward</button>
    <button type="button" onClick={onDown} title="Move down" className="material-icons text-lg hover:text-gray-700 dark:hover:text-gray-200">arrow_downward</button>
    <button type="button" onClick={onRemove} title="Remove" className="material-icons text-lg hover:text-red-500">delete_outline</button>
  </div>
);
