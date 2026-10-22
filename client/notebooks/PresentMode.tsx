import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cell, CellOutput } from './types';
import { NotebookMarkdown } from './NotebookMarkdown';
import { darculaClass, useCodeTheme } from './codeTheme';
import { CodeEditor } from './CodeEditor';
import { CellOutputView } from './CellOutputView';

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

// Scratch edits made while presenting: a cell's source as shown on stage, keyed by cell id. They
// are never saved to the notebook; a run with them returns outputs that are not stored either.
export type Drafts = Record<string, string>;

// Which cells a run with drafts touches: the cells whose draft differs from the notebook
export const changedDrafts = (cells: Cell[], drafts: Drafts): Drafts => {
  const out: Drafts = {};
  for (const c of cells) if (c.kind === 'code' && drafts[c.id] !== undefined && drafts[c.id] !== c.source) out[c.id] = drafts[c.id];
  return out;
};

interface PresentModeProps {
  title: string;
  cells: Cell[];
  outputs: Record<string, CellOutput>;
  runningIds: Set<string>;
  canRun: boolean;
  startAt?: string | null; // cell id to open on
  // Runs a cell. With scratch edits the run is ephemeral: it resolves to the outputs instead of
  // storing them; without, it behaves as in the notebook (stored, resolves to null).
  onRun: (cellId: string, overrides: Drafts) => Promise<Record<string, CellOutput> | null>;
  onClose: () => void;
}

export const PresentMode: React.FC<PresentModeProps> = ({ title, cells, outputs, runningIds, canRun, startAt, onRun, onClose }) => {
  const slides = useMemo(() => slidesOf(cells), [cells]);
  const initial = Math.max(0, slides.findIndex((s) => s.some((c) => c.id === startAt)));
  const [index, setIndex] = useState(initial);
  const [drafts, setDrafts] = useState<Drafts>({});
  // Outputs of ephemeral runs, shown in place of the stored ones while the scratch edit lasts
  const [scratchOutputs, setScratchOutputs] = useState<Record<string, CellOutput>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const root = useRef<HTMLDivElement>(null);
  const slide = slides[Math.min(index, slides.length - 1)] || [];
  const changed = useMemo(() => changedDrafts(cells, drafts), [cells, drafts]);
  const changedCount = Object.keys(changed).length;

  useEffect(() => {
    const el = root.current;
    el?.focus();
    // Fullscreen is a nicety: phones and some app views refuse it. The whole document goes
    // fullscreen, not this element, so the page's toasts (a failed run, a rate limit) stay visible.
    document.documentElement.requestFullscreen?.().catch(() => {});
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

  const run = useCallback(async (cellId: string) => {
    const overrides = changedDrafts(cells, draftsRef.current);
    const fresh = await onRun(cellId, overrides);
    // A stored run (no scratch edits) supersedes every scratch output
    setScratchOutputs((prev) => (fresh ? { ...prev, ...fresh } : {}));
  }, [cells, onRun]);

  // Back to the notebook's version of the cell; its stored output shows again
  const reset = useCallback((cellId: string) => {
    setDrafts((d) => { const n = { ...d }; delete n[cellId]; return n; });
    setScratchOutputs((o) => { const n = { ...o }; delete n[cellId]; return n; });
  }, []);

  const [codeTheme] = useCodeTheme();
  return (
    <div ref={root} tabIndex={-1} className={`fixed inset-0 z-[60] bg-white dark:bg-gray-900 flex flex-col outline-none lp-present ${codeTheme === 'darcula' ? 'lp-darcula-scope' : ''}`} role="dialog" aria-label={`Presenting ${title}`}>
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-800 text-sm text-gray-500 dark:text-gray-400">
        <span className="font-bold text-gray-700 dark:text-gray-200 truncate">{title}</span>
        <div className="flex items-center gap-3">
          {changedCount > 0 && (
            <span className="rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 px-2.5 py-0.5 text-xs font-bold" title="Edits made while presenting are not saved to the notebook">
              {changedCount} scratch {changedCount === 1 ? 'edit' : 'edits'} · not saved
            </span>
          )}
          <span className="tabular-nums">{index + 1} / {slides.length}</span>
          <button type="button" onClick={onClose} className="px-3 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 font-semibold">Exit (Esc)</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-10 space-y-6">
          {slide.map((c) => {
            if (c.kind === 'text') return <NotebookMarkdown key={c.id} source={c.source} className="prose-xl" />;
            const edited = changed[c.id] !== undefined;
            // An edited cell shows only what its scratch code produced; the stored output is of other code
            const output = edited ? scratchOutputs[c.id] : (scratchOutputs[c.id] || outputs[c.id]);
            const error = output && output.status === 'error' && output.error ? { ...output.error, stamp: output.ranAt } : null;
            return (
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
                  <div className="min-w-0 flex-1">
                    <div className={`lp-code-box rounded-xl border bg-gray-50 dark:bg-gray-950 overflow-hidden text-lg ${edited ? 'border-amber-400 dark:border-amber-600' : 'border-gray-200 dark:border-gray-700'} ${canRun ? 'focus-within:border-primary-dark' : ''} ${darculaClass(codeTheme)}`}>
                      <CodeEditor
                        value={drafts[c.id] ?? c.source}
                        language="java"
                        readOnly={!canRun}
                        error={error}
                        onChange={(v) => setDrafts((d) => ({ ...d, [c.id]: v }))}
                        onRun={canRun ? () => { run(c.id); } : undefined}
                      />
                    </div>
                    {edited && (
                      <div className="mt-1 flex items-center gap-3 text-xs text-amber-700 dark:text-amber-300">
                        <span>Scratch edit: runs here, is not saved to the notebook.</span>
                        <button type="button" onClick={() => reset(c.id)} className="font-bold underline decoration-dotted hover:text-amber-900 dark:hover:text-amber-100">Reset to the notebook's code</button>
                      </div>
                    )}
                  </div>
                </div>
                {output && <div className={`lp-output-box ml-[3.25rem] rounded-xl border border-gray-100 dark:border-gray-800 text-base ${darculaClass(codeTheme)}`}><CellOutputView output={output} /></div>}
              </div>
            );
          })}
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
