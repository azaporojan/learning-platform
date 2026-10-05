import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CourseDetail, Phase, RoadLesson, User } from '../types';
import { apiUrl } from '../config';
import { shortPhaseName } from '../roadState';

interface LessonScriptPageProps {
  currentUser: User;
}

const DRAFT_KEY = (lessonId: string) => `lesson-script-draft-${lessonId}`;

// Admin only: the teacher's Markdown script for a lesson. "Edit" shows the source next to a live
// preview; "Follow" is the clean rendered view to keep open during the session, with prev/next
// lesson navigation across the whole course.
export const LessonScriptPage: React.FC<LessonScriptPageProps> = ({ currentUser }) => {
  const { courseId, lessonId } = useParams();
  const navigate = useNavigate();
  const isAdmin = currentUser.role === 'admin';

  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [script, setScript] = useState('');
  const [saved, setSaved] = useState('');
  const [title, setTitle] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [mode, setMode] = useState<'edit' | 'follow'>('follow');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    if (!courseId || !lessonId) return;
    setLoaded(false);
    try {
      const [cr, sr] = await Promise.all([
        fetch(apiUrl(`/courses/${courseId}`), { credentials: 'include' }),
        fetch(apiUrl(`/lessons/${lessonId}/script`), { credentials: 'include' }),
      ]);
      if (!cr.ok || !sr.ok) { setNotFound(true); return; }
      const c: CourseDetail = await cr.json();
      const s: { title: string; script: string } = await sr.json();
      setCourse(c);
      setTitle(s.title);
      setSaved(s.script);
      let draft: string | null = null;
      try { draft = localStorage.getItem(DRAFT_KEY(lessonId)); } catch { /* ignore */ }
      setScript(draft !== null && draft !== s.script ? draft : s.script);
      setMode(s.script.trim() ? 'follow' : 'edit');
    } catch (err) {
      console.error('Failed to load lesson script', err);
    } finally {
      setLoaded(true);
    }
  }, [courseId, lessonId]);

  useEffect(() => { load(); }, [load]);

  // Keep an unsaved draft per lesson in this browser
  useEffect(() => {
    if (!lessonId || !loaded) return;
    try {
      if (script !== saved) localStorage.setItem(DRAFT_KEY(lessonId), script);
      else localStorage.removeItem(DRAFT_KEY(lessonId));
    } catch { /* ignore */ }
  }, [script, saved, lessonId, loaded]);

  const dirty = script !== saved;

  const save = async () => {
    if (!lessonId) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/lessons/${lessonId}/script`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ script })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save');
      }
      setSaved(script);
      setSavedAt(new Date());
    } catch (err: any) {
      setError(err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Ctrl/Cmd+S saves while editing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty && !saving) save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = useMemo(() => {
    if (!course) return [] as { lesson: RoadLesson; phase: Phase; number: number }[];
    let n = 0;
    return course.phases.flatMap((phase) => phase.lessons.map((lesson) => ({ lesson, phase, number: ++n })));
  }, [course]);
  const index = flat.findIndex((f) => String(f.lesson.id) === String(lessonId));
  const current = index >= 0 ? flat[index] : null;
  const prev = index > 0 ? flat[index - 1] : null;
  const next = index >= 0 && index < flat.length - 1 ? flat[index + 1] : null;

  const goTo = (target: { lesson: RoadLesson } | null) => {
    if (!target) return;
    if (dirty && !window.confirm('You have unsaved changes. Leave anyway? (The draft stays in this browser.)')) return;
    navigate(`/courses/${courseId}/lessons/${target.lesson.id}/script`);
  };

  if (!isAdmin) return <Navigate to={`/courses/${courseId}`} replace />;

  if (notFound) {
    return (
      <div className="h-full flex items-center justify-center text-center text-gray-500">
        <div>
          <span className="material-icons text-6xl text-gray-300 mb-3">description</span>
          <p className="font-semibold text-lg">This lesson does not exist.</p>
          <button onClick={() => navigate(`/courses/${courseId}`)} className="mt-4 text-primary-dark font-bold hover:underline">Back to the course</button>
        </div>
      </div>
    );
  }
  if (!loaded || !course) {
    return <div className="h-full flex items-center justify-center"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" /></div>;
  }

  const rendered = (
    <div className="prose prose-lg dark:prose-invert max-w-none prose-headings:scroll-mt-20 prose-table:text-base prose-th:bg-gray-100 dark:prose-th:bg-gray-800 prose-th:px-3 prose-td:px-3 prose-pre:bg-gray-900">
      {script.trim() ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{script}</ReactMarkdown>
      ) : (
        <p className="text-gray-400 italic">No script yet. Switch to Edit and write the plan for this lesson in Markdown: headings, bullet lists, tables, code blocks.</p>
      )}
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-white dark:bg-gray-900 rounded-3xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3 flex-wrap bg-white dark:bg-gray-900">
        <button onClick={() => { if (!dirty || window.confirm('You have unsaved changes. Leave anyway? (The draft stays in this browser.)')) navigate(`/courses/${courseId}`); }} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" title="Back to the course">
          <span className="material-icons">arrow_back</span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-gray-400">
            <span className="material-icons text-sm text-purple-500">lock</span>
            Lesson script · admin only
            {current && <span className="normal-case tracking-normal text-gray-400">· {shortPhaseName(current.phase)} · lesson {current.number}/{flat.length}</span>}
          </div>
          <h2 className="text-xl font-extrabold italic text-gray-800 dark:text-white truncate">{title}</h2>
        </div>

        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
          <button onClick={() => setMode('follow')} className={`px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1 ${mode === 'follow' ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500'}`}>
            <span className="material-icons text-base">slideshow</span>Follow
          </button>
          <button onClick={() => setMode('edit')} className={`px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1 ${mode === 'edit' ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500'}`}>
            <span className="material-icons text-base">edit</span>Edit
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => goTo(prev)} disabled={!prev} title={prev ? prev.lesson.title : 'First lesson'} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors">
            <span className="material-icons">chevron_left</span>
          </button>
          <button onClick={() => goTo(next)} disabled={!next} title={next ? next.lesson.title : 'Last lesson'} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors">
            <span className="material-icons">chevron_right</span>
          </button>
        </div>

        <button
          onClick={save}
          disabled={!dirty || saving}
          className={`flex items-center space-x-1.5 font-bold px-4 py-2 rounded-xl shadow-md transition-colors text-sm ${dirty ? 'bg-primary hover:bg-primary-dark text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-500 cursor-default'}`}
          title="Save (Ctrl+S)"
        >
          <span className="material-icons text-base">{saving ? 'hourglass_top' : dirty ? 'save' : 'check'}</span>
          <span>{saving ? 'Saving…' : dirty ? 'Save' : savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : 'Saved'}</span>
        </button>
      </div>

      {error && <div className="mx-5 mt-3 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg text-red-700 dark:text-red-300 text-sm">{error}</div>}

      {/* Body */}
      {mode === 'edit' ? (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2">
          <div className="min-h-0 flex flex-col border-b lg:border-b-0 lg:border-r border-gray-200 dark:border-gray-700">
            <div className="px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-gray-400 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
              <span>Markdown</span>
              <span className="normal-case tracking-normal font-semibold">{script.length.toLocaleString()} chars{dirty ? ' · unsaved' : ''}</span>
            </div>
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              spellCheck={false}
              placeholder={'# Week 1 — Code: setup\n\n## 0:00 Warm-up (10 min)\n- …\n\n## 0:10 Concept (20 min)\n| Topic | Example |\n|---|---|\n| Variables | `int x = 5;` |\n\n```java\nSystem.out.println("hello");\n```'}
              className="flex-1 min-h-0 w-full resize-none p-4 font-mono text-sm leading-relaxed bg-gray-50 dark:bg-gray-950 text-gray-800 dark:text-gray-100 outline-none"
            />
          </div>
          <div className="min-h-0 overflow-y-auto custom-scrollbar">
            <div className="px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-gray-400 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900">Preview</div>
            <div className="p-6">{rendered}</div>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          <div className="max-w-4xl mx-auto px-8 py-8">{rendered}</div>
          <div className="max-w-4xl mx-auto px-8 pb-10 flex items-center justify-between text-sm">
            <button onClick={() => goTo(prev)} disabled={!prev} className="flex items-center gap-1 font-bold text-gray-500 hover:text-primary-dark disabled:opacity-30">
              <span className="material-icons text-base">chevron_left</span>{prev ? prev.lesson.title : 'First lesson'}
            </button>
            <button onClick={() => goTo(next)} disabled={!next} className="flex items-center gap-1 font-bold text-gray-500 hover:text-primary-dark disabled:opacity-30 text-right">
              {next ? next.lesson.title : 'Last lesson'}<span className="material-icons text-base">chevron_right</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
