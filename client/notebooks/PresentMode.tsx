import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Cell, CellOutput } from './types';
import { NotebookMarkdown } from './NotebookMarkdown';
import { darculaClass, useCodeTheme } from './codeTheme';
import { CodeEditor } from './CodeEditor';
import { CellOutputView } from './CellOutputView';
import { Drafts, applyDrafts, dropScratchFrom, isDrafted, withDraft } from './presentDrafts';

// A slide starts at every text cell that opens with a "#" or "##" heading; the cells after it
// (text and code) belong to that slide until the next heading.
export function slidesOf(cells: Cell[]): Cell[][] {
  const slides: Cell[][] = [];
  for (const c of cells) {
    const startsSlide = c.kind === 'text' && /^\s*#{1,2}\s+\S/.test(c.source);
    if (startsSlide || slides.length === 0) slides.push([c]);
    else slides[slides.length - 1].push(c);
  }
  return slides;
}

interface PresentModeProps {
  title: string;
  cells: Cell[];
  outputs: Record<string, CellOutput>;
  runningIds: Set<string>;
  canRun: boolean;
  startAt?: string | null; // cell id to open on
  // `scratch` is the cells with the presenter's unsaved edits applied, when there are any. Such a
  // run is not stored anywhere: its outputs come back here instead of joining the notebook's.
  onRun: (cellId: string, scratch?: Cell[]) => Promise<Record<string, CellOutput> | undefined>;
  onClose: () => void;
}

export const PresentMode: React.FC<PresentModeProps> = ({ title, cells, outputs, runningIds, canRun, startAt, onRun, onClose }) => {
  const slides = useMemo(() => slidesOf(cells), [cells]);
  const initial = Math.max(0, slides.findIndex((s) => s.some((c) => c.id === startAt)));
  const [index, setIndex] = useState(initial);
  const root = useRef<HTMLDivElement>(null);
  const slide = slides[Math.min(index, slides.length - 1)] || [];
  // Code cells can be edited on the spot to expand an example. The edits, and the outputs of
  // running them, live here in memory for as long as the presentation is open and are never
  // saved to the notebook; closing the presentation drops them.
  const [drafts, setDrafts] = useState<Drafts>({});
  const [scratchOutputs, setScratchOutputs] = useState<Record<string, CellOutput>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const edited = Object.keys(drafts).length > 0;
  const run = async (cellId: string) => {
    const d = draftsRef.current;
    if (!Object.keys(d).length) { await onRun(cellId); return; }
    const fresh = await onRun(cellId, applyDrafts(cells, d));
    if (fresh) setScratchOutputs((prev) => ({ ...prev, ...fresh }));
  };
  const resetDraft = (cellId: string) => {
    setDrafts((d) => { const next = { ...d }; delete next[cellId]; return next; });
    setScratchOutputs((o) => dropScratchFrom(o, cells, cellId));
  };
  const resetAll = () => { setDrafts({}); setScratchOutputs({}); };
  // Scratch outputs only make sense next to the edits that produced them: once the last draft is
  // gone (reset, or typed back to the saved text) the saved outputs show again
  useEffect(() => { if (!edited) setScratchOutputs({}); }, [edited]);
  const outputOf = (cellId: string): CellOutput | undefined => (edited && scratchOutputs[cellId]) || outputs[cellId];

  useEffect(() => {
    const el = root.current;
    el?.focus();
    // Fullscreen is a nicety: phones and some app views refuse it
    el?.requestFullscreen?.().catch(() => {});
    return () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inEditor = (e.target as HTMLElement)?.closest?.('.cm-editor');
      if (inEditor) return;
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); setIndex((i) => Math.min(slides.length - 1, i + 1)); }
      if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
      if (e.key === 'Home') setIndex(0);
      if (e.key === 'End') setIndex(slides.length - 1);
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slides.length, onClose]);

  const [codeTheme] = useCodeTheme();
  return (
    <div ref={root} tabIndex={-1} className={`fixed inset-0 z-[60] bg-white dark:bg-gray-900 flex flex-col outline-none lp-present ${codeTheme === 'darcula' ? 'lp-darcula-scope' : ''}`} role="dialog" aria-label={`Presenting ${title}`}>
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-800 text-sm text-gray-500 dark:text-gray-400">
        <span className="font-bold text-gray-700 dark:text-gray-200 truncate">{title}</span>
        <div className="flex items-center gap-3">
          {edited && (
            <span className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <span className="font-semibold">Edited here, not saved</span>
              <button type="button" onClick={resetAll} className="px-2 py-0.5 rounded-lg border border-amber-300 dark:border-amber-700 hover:bg-amber-50 dark:hover:bg-amber-900/30 font-semibold">Reset all</button>
            </span>
          )}
          <span className="tabular-nums">{index + 1} / {slides.length}</span>
          <button type="button" onClick={onClose} className="px-3 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 font-semibold">Exit (Esc)</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-10 space-y-6">
          {slide.map((c) => (c.kind === 'text' ? (
            <NotebookMarkdown key={c.id} source={c.source} className="prose-xl" />
          ) : (
            <div key={c.id} className="space-y-2">
              <div className="flex items-start gap-3">
                {canRun && (
                  <button
                    type="button"
                    onClick={() => run(c.id)}
                    disabled={runningIds.has(c.id)}
                    aria-label="Run cell"
                    className="mt-2 w-10 h-10 shrink-0 rounded-full flex items-center justify-center bg-primary text-gray-900 hover:bg-primary-dark hover:text-white disabled:opacity-60"
                  >
                    {runningIds.has(c.id) ? <span className="lp-spinner" /> : <span aria-hidden="true" className="material-icons">play_arrow</span>}
                  </button>
                )}
                <div className={`lp-code-box min-w-0 flex-1 rounded-xl border bg-gray-50 dark:bg-gray-950 overflow-hidden text-lg ${isDrafted(drafts, c) ? 'border-amber-300 dark:border-amber-700' : 'border-gray-200 dark:border-gray-700'} ${darculaClass(codeTheme)}`}>
                  <CodeEditor
                    value={c.id in drafts ? drafts[c.id] : c.source}
                    language="java"
                    onChange={(v) => setDrafts((d) => withDraft(d, c, v))}
                    onRun={canRun ? () => run(c.id) : undefined}
                    onEscape={() => root.current?.focus()}
                    errorLine={outputOf(c.id)?.error?.line ?? null}
                  />
                </div>
              </div>
              {isDrafted(drafts, c) && (
                <div className="ml-[3.25rem] flex items-center gap-3 text-sm text-amber-700 dark:text-amber-400">
                  <span>Edited for this presentation only. The notebook keeps the original.</span>
                  <button type="button" onClick={() => resetDraft(c.id)} className="font-semibold underline hover:no-underline">Reset</button>
                </div>
              )}
              {outputOf(c.id) && <div className={`lp-output-box ml-[3.25rem] rounded-xl border border-gray-100 dark:border-gray-800 text-base ${darculaClass(codeTheme)}`}><CellOutputView output={outputOf(c.id)!} /></div>}
            </div>
          )))}
        </div>
      </div>
      <div className="flex items-center justify-center gap-4 py-3 border-t border-gray-100 dark:border-gray-800">
        <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} className="px-4 py-2 rounded-xl font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30">
          <span aria-hidden="true" className="material-icons align-middle">chevron_left</span> Previous
        </button>
        <button type="button" onClick={() => setIndex((i) => Math.min(slides.length - 1, i + 1))} disabled={index >= slides.length - 1} className="px-4 py-2 rounded-xl font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30">
          Next <span aria-hidden="true" className="material-icons align-middle">chevron_right</span>
        </button>
      </div>
    </div>
  );
};
