import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Cell, CellOutput } from './types';
import { NotebookMarkdown } from './NotebookMarkdown';
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

interface PresentModeProps {
  title: string;
  cells: Cell[];
  outputs: Record<string, CellOutput>;
  runningIds: Set<string>;
  canRun: boolean;
  startAt?: string | null; // cell id to open on
  onRun: (cellId: string) => void;
  onClose: () => void;
}

export const PresentMode: React.FC<PresentModeProps> = ({ title, cells, outputs, runningIds, canRun, startAt, onRun, onClose }) => {
  const slides = useMemo(() => slidesOf(cells), [cells]);
  const initial = Math.max(0, slides.findIndex((s) => s.some((c) => c.id === startAt)));
  const [index, setIndex] = useState(initial);
  const root = useRef<HTMLDivElement>(null);
  const slide = slides[Math.min(index, slides.length - 1)] || [];

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

  return (
    <div ref={root} tabIndex={-1} className="fixed inset-0 z-[60] bg-white flex flex-col outline-none lp-present" role="dialog" aria-label={`Presenting ${title}`}>
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 text-sm text-gray-500">
        <span className="font-bold text-gray-700 truncate">{title}</span>
        <div className="flex items-center gap-3">
          <span className="tabular-nums">{index + 1} / {slides.length}</span>
          <button type="button" onClick={onClose} className="px-3 py-1 rounded-lg hover:bg-gray-100 font-semibold">Exit (Esc)</button>
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
                    onClick={() => onRun(c.id)}
                    disabled={runningIds.has(c.id)}
                    aria-label="Run cell"
                    className="mt-2 w-10 h-10 shrink-0 rounded-full flex items-center justify-center bg-primary text-gray-900 hover:bg-primary-dark hover:text-white disabled:opacity-60"
                  >
                    {runningIds.has(c.id) ? <span className="lp-spinner" /> : <span aria-hidden="true" className="material-icons">play_arrow</span>}
                  </button>
                )}
                <div className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 overflow-hidden text-lg">
                  <CodeEditor value={c.source} language="java" readOnly onChange={() => {}} />
                </div>
              </div>
              {outputs[c.id] && <div className="ml-[3.25rem] rounded-xl border border-gray-100 text-base"><CellOutputView output={outputs[c.id]} /></div>}
            </div>
          )))}
        </div>
      </div>
      <div className="flex items-center justify-center gap-4 py-3 border-t border-gray-100">
        <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} className="px-4 py-2 rounded-xl font-bold text-gray-600 hover:bg-gray-100 disabled:opacity-30">
          <span aria-hidden="true" className="material-icons align-middle">chevron_left</span> Previous
        </button>
        <button type="button" onClick={() => setIndex((i) => Math.min(slides.length - 1, i + 1))} disabled={index >= slides.length - 1} className="px-4 py-2 rounded-xl font-bold text-gray-600 hover:bg-gray-100 disabled:opacity-30">
          Next <span aria-hidden="true" className="material-icons align-middle">chevron_right</span>
        </button>
      </div>
    </div>
  );
};
