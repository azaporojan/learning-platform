import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CourseDetail, User } from '../types';
import { apiUrl } from '../config';
import { Cell, CellKind, CellOutput, Notebook, NotebookSummary } from '../notebooks/types';
import { api, ApiError, newCellId, newRequestId, timeAgo } from '../notebooks/api';
import { AddCellBar, CellAction, CellView, CellViewHandle } from '../notebooks/CellView';
import { headingsOf } from '../notebooks/NotebookMarkdown';
import { PresentMode } from '../notebooks/PresentMode';
import { Modal } from '../notebooks/Modal';
import { useCodeTheme } from '../notebooks/codeTheme';
import { activeHeadingIndex } from '../notebooks/outlineSpy';

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';
interface Toast { text: string; action?: { label: string; run: () => void } }

const AUTOSAVE_MS = 2000;
// The outline heading's element: the rendered heading, or its cell while the cell is being edited
function headingElement(cellId: string, nth: number): Element | null {
  const cell = document.querySelector(`[data-cell-id="${cellId}"]`);
  if (!cell) return null;
  return Array.from(cell.querySelectorAll('h1, h2, h3')).filter((el) => !el.closest('blockquote, li'))[nth] ?? cell;
}

// Where reading starts in the notebook: a little below its sticky toolbar
function readingLine(scroller: HTMLElement): number {
  const toolbar = scroller.firstElementChild;
  return (toolbar?.getBoundingClientRect().bottom ?? scroller.getBoundingClientRect().top) + 24;
}

const OUTLINE_KEY = 'notebook-outline-open';

const readPref = (key: string, fallback: boolean) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; }
};
const writePref = (key: string, value: boolean) => { try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* ignore */ } };

const SHORTCUTS: [string, string][] = [
  ['Shift+Enter', 'Run the cell (and the cells above it), select the next'],
  ['Ctrl+Enter', 'Run the cell, stay on it'],
  ['Alt+Enter', 'Run the cell, insert a code cell below'],
  ['Enter', 'Edit the selected cell'],
  ['Esc', 'Stop editing (command mode)'],
  ['↑ / ↓  or  K / J', 'Select the previous / next cell'],
  ['A / B', 'Add a code cell above / below'],
  ['M / Y', 'Make the cell text / code'],
  ['D D', 'Delete the cell (Z undoes)'],
  ['Z', 'Undo the last cell operation'],
  ['Ctrl+S', 'Save now (autosave runs anyway)'],
  ['Ctrl+/', 'Comment or uncomment lines'],
  ['Ctrl+Space', 'Suggestions'],
  ['Ctrl+Alt+L', 'Reformat the code (the selected lines, if any)'],
  ['Ctrl+D', 'Duplicate the line or the selection'],
  ['Ctrl+Y', 'Delete the line (redo is Ctrl+Shift+Z in code)'],
  ['Shift+Alt+↑ / ↓', 'Move the line up / down'],
  ['sout + Tab', 'System.out.println();  also souf, serr, fori, iter'],
];

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return Boolean(el.closest('.cm-editor') || el.closest('input, textarea, select, [contenteditable="true"]'));
};

export const NotebookPage: React.FC<{ currentUser: User }> = ({ currentUser }) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isAdmin = currentUser.role === 'admin';

  const [nb, setNb] = useState<Notebook | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [cells, setCellsState] = useState<Cell[]>([]);
  const [outputs, setOutputs] = useState<Record<string, CellOutput>>({});
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Drag and drop of cells: the cell being dragged, and where it would land
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [queuedAhead, setQueuedAhead] = useState(0);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [runnerNotice, setRunnerNotice] = useState<string | null>(null);
  const [liveSession, setLiveSession] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(() => readPref(OUTLINE_KEY, true));
  const [outlineDrawer, setOutlineDrawer] = useState(false);
  // The outline entry for the section being read (follows the scroll)
  const [activeHeading, setActiveHeading] = useState<number | null>(null);
  const [dialog, setDialog] = useState<null | 'shortcuts' | 'settings' | 'copies'>(null);
  const [codeTheme, setCodeTheme] = useCodeTheme();
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');

  const cellsRef = useRef<Cell[]>([]);
  const revisionRef = useRef(0);
  const changeSeq = useRef(0);
  const savedSeq = useRef(0);
  const saveTimer = useRef<number | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const undoStack = useRef<{ cells: Cell[]; selectedId: string | null }[]>([]);
  const cellRefs = useRef(new Map<string, CellViewHandle>());
  const lastD = useRef(0);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageTarget = useRef<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((t: Toast, ms = 5000) => {
    setToast(t);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------
  const load = useCallback(async () => {
    try {
      const data = await api<Notebook>(`/notebooks/${id}`);
      setNb(data);
      setTitle(data.title);
      cellsRef.current = data.cells;
      setCellsState(data.cells);
      setOutputs(data.outputs || {});
      revisionRef.current = data.revision;
      changeSeq.current = 0;
      savedSeq.current = 0;
      undoStack.current = [];
      setSaveState('saved');
      setSelectedId((s) => (s && data.cells.some((c) => c.id === s) ? s : (data.cells[0] ? data.cells[0].id : null)));
      setLoadError(null);
      if (!data.runner_configured && data.can_run) setRunnerNotice('Running code is not set up on this server yet. You can still write and save.');
    } catch (e) {
      const err = e as ApiError;
      setLoadError({ status: err.status || 0, message: err.message });
    }
  }, [id]);

  useEffect(() => { setNb(null); load(); }, [load]);

  // -------------------------------------------------------------------------
  // Saving: one queue, so a title change and a cell save never race on the revision
  // -------------------------------------------------------------------------
  const enqueue = useCallback((job: () => Promise<void>) => {
    saveChain.current = saveChain.current.then(job, job);
    return saveChain.current;
  }, []);

  const saveCells = useCallback(() => enqueue(async () => {
    if (!nb || !nb.can_edit) return;
    if (changeSeq.current === savedSeq.current) return;
    const seq = changeSeq.current;
    setSaveState('saving');
    try {
      const r = await api<{ revision: number }>(`/notebooks/${nb.id}`, { method: 'PUT', json: { cells: cellsRef.current, baseRevision: revisionRef.current } });
      revisionRef.current = r.revision;
      savedSeq.current = seq;
      setSaveState(changeSeq.current === seq ? 'saved' : 'dirty');
    } catch (e) {
      const err = e as ApiError;
      setSaveState(err.status === 409 ? 'conflict' : 'error');
    }
  }), [enqueue, nb]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { saveTimer.current = null; saveCells(); }, AUTOSAVE_MS);
  }, [saveCells]);

  const saveNow = useCallback(() => {
    if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    return saveCells();
  }, [saveCells]);

  // Unsaved work: warn before leaving the site, and flush when leaving the page inside the app.
  // The page is remounted per notebook (see App), so this only ever saves its own notebook.
  const nbRef = useRef<Notebook | null>(null);
  nbRef.current = nb;
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (changeSeq.current !== savedSeq.current) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      const current = nbRef.current;
      if (current && current.can_edit && changeSeq.current !== savedSeq.current) {
        fetch(apiUrl(`/notebooks/${current.id}`), {
          method: 'PUT', credentials: 'include', keepalive: true, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cells: cellsRef.current, baseRevision: revisionRef.current }),
        }).catch(() => {});
      }
    };
  }, []);

  // Every change of the cells goes through here. structural = add / delete / move / convert (undoable)
  const updateCells = useCallback((next: Cell[], { structural = false }: { structural?: boolean } = {}) => {
    if (structural) {
      undoStack.current.push({ cells: cellsRef.current, selectedId });
      if (undoStack.current.length > 50) undoStack.current.shift();
    }
    cellsRef.current = next;
    setCellsState(next);
    changeSeq.current += 1;
    setSaveState((s) => (s === 'conflict' ? s : 'dirty'));
    scheduleSave();
  }, [scheduleSave, selectedId]);

  const saveTitle = useCallback(async (value: string) => {
    if (!nb) return;
    const t = value.trim();
    setEditingTitle(false);
    if (!t || t === nb.title) { setTitle(nb.title); return; }
    await enqueue(async () => {
      try {
        const r = await api<{ revision: number }>(`/notebooks/${nb.id}`, { method: 'PUT', json: { title: t } });
        revisionRef.current = r.revision;
        setNb({ ...nb, title: t });
      } catch (e) {
        setTitle(nb.title);
        showToast({ text: (e as Error).message });
      }
    });
  }, [enqueue, nb, showToast]);

  // -------------------------------------------------------------------------
  // Cell operations
  // -------------------------------------------------------------------------
  const indexOf = (cellId: string | null) => cellsRef.current.findIndex((c) => c.id === cellId);

  const addCell = useCallback((at: number, kind: CellKind, focus = true) => {
    const cell: Cell = { id: newCellId(), kind, source: '' };
    const next = [...cellsRef.current];
    next.splice(Math.max(0, Math.min(at, next.length)), 0, cell);
    updateCells(next, { structural: true });
    setSelectedId(cell.id);
    if (focus) {
      setEditingId(cell.id);
      if (kind === 'code') window.setTimeout(() => cellRefs.current.get(cell.id)?.focusEditor(), 0);
    }
    return cell.id;
  }, [updateCells]);

  const undo = useCallback(() => {
    const last = undoStack.current.pop();
    if (!last) { showToast({ text: 'Nothing to undo' }, 1500); return; }
    cellsRef.current = last.cells;
    setCellsState(last.cells);
    setSelectedId(last.selectedId);
    changeSeq.current += 1;
    setSaveState('dirty');
    scheduleSave();
  }, [scheduleSave, showToast]);

  // A dragged cell that disappears mid-drag (deleted, or the notebook reloaded) never fires
  // dragend: drop the drag state with it so no drop line stays behind
  useEffect(() => {
    if (dragId && !cells.some((c) => c.id === dragId)) { setDragId(null); setDropAt(null); }
  }, [cells, dragId]);

  // One undoable move, like the arrows; dropping a cell next to itself changes nothing
  const moveCellTo = useCallback((fromId: string, targetId: string, position: 'before' | 'after') => {
    const list = [...cellsRef.current];
    const from = list.findIndex((c) => c.id === fromId);
    if (from === -1 || fromId === targetId) return;
    const [moved] = list.splice(from, 1);
    const target = list.findIndex((c) => c.id === targetId);
    if (target === -1) return;
    list.splice(position === 'before' ? target : target + 1, 0, moved);
    if (list.every((c, i) => c.id === cellsRef.current[i].id)) return;
    updateCells(list, { structural: true });
    setSelectedId(fromId);
  }, [updateCells]);

  const cellAction = useCallback((cellId: string, action: CellAction) => {
    const i = indexOf(cellId);
    if (i === -1) return;
    const list = [...cellsRef.current];
    if (action === 'up' && i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; updateCells(list, { structural: true }); }
    if (action === 'down' && i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; updateCells(list, { structural: true }); }
    if (action === 'convert') {
      list[i] = { ...list[i], kind: list[i].kind === 'code' ? 'text' : 'code' };
      updateCells(list, { structural: true });
    }
    if (action === 'delete') {
      list.splice(i, 1);
      updateCells(list, { structural: true });
      setSelectedId(list[Math.min(i, list.length - 1)]?.id || null);
      setEditingId(null);
      showToast({ text: 'Cell deleted', action: { label: 'Undo', run: undo } });
    }
    if (action === 'image') {
      imageTarget.current = cellId;
      imageInput.current?.click();
    }
  }, [updateCells, showToast, undo]);

  const setSource = useCallback((cellId: string, source: string) => {
    const current = cellsRef.current.find((c) => c.id === cellId);
    if (!current || current.source === source) return;
    const list = cellsRef.current.map((c) => (c.id === cellId ? { ...c, source } : c));
    updateCells(list);
  }, [updateCells]);

  // A code cell's input; an empty box removes it
  const setInput = useCallback((cellId: string, input: string) => {
    const current = cellsRef.current.find((c) => c.id === cellId);
    if (!current || (current.input || '') === input) return;
    const list = cellsRef.current.map((c) => {
      if (c.id !== cellId) return c;
      const { input: _old, ...rest } = c;
      return input ? { ...rest, input } : rest;
    });
    updateCells(list);
  }, [updateCells]);

  // Images: a placeholder goes in at once, the real link replaces it when the upload is done
  const uploadImages = useCallback(async (cellId: string, files: File[]) => {
    if (!nb) return;
    for (const file of files) {
      const placeholder = `![Uploading ${file.name.replace(/[[\]]/g, '')}…]()`;
      const handle = cellRefs.current.get(cellId);
      if (editingId === cellId && handle) handle.insert(`${placeholder}\n`);
      else {
        const cell = cellsRef.current.find((c) => c.id === cellId);
        if (cell) setSource(cellId, `${cell.source}${cell.source && !cell.source.endsWith('\n') ? '\n\n' : ''}${placeholder}\n`);
      }
      const swap = (replacement: string) => {
        const cell = cellsRef.current.find((c) => c.id === cellId);
        if (cell && cell.source.includes(placeholder)) setSource(cellId, cell.source.replace(placeholder, replacement));
      };
      try {
        const form = new FormData();
        form.append('file', file);
        const r = await api<{ url: string }>(`/notebooks/${nb.id}/files`, { form });
        swap(`![${file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[[\]]/g, '')}](${r.url})`);
      } catch (e) {
        swap('');
        showToast({ text: `${file.name}: ${(e as Error).message}` });
      }
    }
  }, [nb, editingId, setSource, showToast]);

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------
  const applyOutputs = useCallback((fresh: Record<string, CellOutput>) => {
    setOutputs((prev) => {
      const changed = new Set<string>();
      for (const [cid, o] of Object.entries(fresh)) {
        const p = prev[cid];
        if (!p || p.status !== o.status || p.stdout !== o.stdout || p.value !== o.value || (p.error && p.error.message) !== (o.error && o.error.message)) changed.add(cid);
      }
      setFlash(changed);
      window.setTimeout(() => setFlash(new Set()), 1200);
      return { ...prev, ...fresh };
    });
  }, []);

  const runningRef = useRef(false);
  // `scratch` (present mode) runs an edited copy of the cells instead of the saved ones. Nothing
  // of such a run is stored: the server keeps neither the cells nor the outputs, and the outputs
  // are handed back to the caller instead of being merged into the notebook's.
  const runCell = useCallback(async (cellId: string, how: 'advance' | 'stay' | 'insert', scratch?: Cell[]): Promise<Record<string, CellOutput> | undefined> => {
    if (!nb) return undefined;
    const i = indexOf(cellId);
    if (i === -1) return undefined;
    const runCells = scratch || cellsRef.current;
    const cell = runCells.find((c) => c.id === cellId) || cellsRef.current[i];
    // Move on first, like Jupyter: the result arrives while you keep working
    if (how === 'advance') {
      const nextCell = cellsRef.current[i + 1];
      if (nextCell) { setSelectedId(nextCell.id); setEditingId(null); if (nextCell.kind === 'code') window.setTimeout(() => cellRefs.current.get(nextCell.id)?.focusEditor(), 0); }
      else if (nb.can_edit) addCell(i + 1, 'code');
    }
    if (how === 'insert' && nb.can_edit) addCell(i + 1, 'code');
    if (cell.kind === 'text') { if (editingId === cellId) setEditingId(null); return undefined; }
    if (!nb.can_run) return undefined;
    if (runningRef.current) { showToast({ text: 'A run is still going. Wait for it to finish.' }, 2500); return undefined; }
    runningRef.current = true;

    const requestId = newRequestId();
    const ids = liveSession ? [cellId] : runCells.slice(0, i + 1).filter((c) => c.kind === 'code').map((c) => c.id);
    setRunningIds(new Set(ids));
    setQueuedAhead(0);
    let polling = true;
    const poll = async () => {
      while (polling) {
        await new Promise((r) => window.setTimeout(r, 700));
        if (!polling) break;
        // position: 1 = next in line, 0 = running (or done)
        try { const q = await api<{ position: number }>(`/notebooks/queue/${requestId}`); if (polling) setQueuedAhead(Math.max(0, q.position)); } catch { /* ignore */ }
      }
    };
    if (!liveSession) poll();
    try {
      let fresh: Record<string, CellOutput>;
      if (liveSession) {
        const r = await api<{ output: CellOutput; sessionEnded: boolean; sessionRestarted: boolean }>(`/notebooks/${nb.id}/session/run`, { json: { cellId, source: cell.source, input: cell.input || '', scratch: Boolean(scratch) } });
        fresh = { [cellId]: r.output };
        if (r.sessionEnded) showToast({ text: 'The live session ended (timeout or crash). The next run starts a fresh one.' });
        else if (r.sessionRestarted) showToast({ text: 'Started a fresh live session: earlier variables are gone.' }, 3500);
      } else {
        const r = await api<{ outputs: Record<string, CellOutput> }>(`/notebooks/${nb.id}/run`, { json: { cells: runCells, upTo: cellId, requestId, scratch: Boolean(scratch) } });
        fresh = r.outputs;
      }
      setRunnerNotice(null);
      if (scratch) return fresh;
      applyOutputs(fresh);
    } catch (e) {
      const err = e as ApiError;
      const code = err.data && err.data.code;
      if (code === 'not_configured' || code === 'unavailable' || code === 'misconfigured') setRunnerNotice(err.message);
      else showToast({ text: err.message }, 6000);
    } finally {
      polling = false;
      runningRef.current = false;
      setRunningIds(new Set());
      setQueuedAhead(0);
    }
    return undefined;
  }, [nb, liveSession, editingId, addCell, applyOutputs, showToast]);

  const clearOutput = useCallback(async (cellId: string) => {
    if (!nb) return;
    setOutputs((prev) => { const n = { ...prev }; delete n[cellId]; return n; });
    try { await api(`/notebooks/${nb.id}/clear-outputs`, { json: { cellIds: [cellId] } }); } catch { /* shown again on reload */ }
  }, [nb]);

  const runAll = useCallback(() => {
    const lastCode = [...cellsRef.current].reverse().find((c) => c.kind === 'code');
    if (lastCode) runCell(lastCode.id, 'stay');
  }, [runCell]);

  const endSession = useCallback(async () => {
    try { await api('/notebooks/session', { method: 'DELETE' }); } catch { /* ignore */ }
    setLiveSession(false);
    showToast({ text: 'Live session ended' }, 2000);
  }, [showToast]);

  // -------------------------------------------------------------------------
  // Keyboard: command mode (no editor focused), the Jupyter set
  // -------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (presenting || dialog) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); return; }
      if (isTyping(e.target)) return;
      const sel = selectedId;
      const i = indexOf(sel);
      const move = (d: number) => {
        const next = cellsRef.current[Math.max(0, Math.min(cellsRef.current.length - 1, i + d))];
        if (next) { setSelectedId(next.id); document.querySelector(`[data-cell-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      };
      const key = e.key;
      if (key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)) {
        if (!sel) return;
        e.preventDefault();
        runCell(sel, e.shiftKey ? 'advance' : e.altKey ? 'insert' : 'stay');
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'z' && nb?.can_edit) { e.preventDefault(); undo(); }
        return;
      }
      if (key === 'ArrowUp' || key === 'k') { e.preventDefault(); move(-1); return; }
      if (key === 'ArrowDown' || key === 'j') { e.preventDefault(); move(1); return; }
      if (key === 'h' || key === '?') { setDialog('shortcuts'); return; }
      if (!sel || !nb?.can_edit) {
        if (key === 'Enter' && sel) { e.preventDefault(); cellRefs.current.get(sel)?.focusEditor(); }
        return;
      }
      if (key === 'Enter') {
        e.preventDefault();
        const cell = cellsRef.current[i];
        setEditingId(sel);
        if (cell && cell.kind === 'code') cellRefs.current.get(sel)?.focusEditor();
        return;
      }
      if (key === 'a') { addCell(i, 'code', false); return; }
      if (key === 'b') { addCell(i + 1, 'code', false); return; }
      if (key === 'm' && cellsRef.current[i]?.kind === 'code') { cellAction(sel, 'convert'); return; }
      if (key === 'y' && cellsRef.current[i]?.kind === 'text') { cellAction(sel, 'convert'); return; }
      if (key === 'z') { undo(); return; }
      if (key === 'd') {
        const now = Date.now();
        if (now - lastD.current < 600) { lastD.current = 0; cellAction(sel, 'delete'); } else lastD.current = now;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenting, dialog, selectedId, nb, runCell, undo, addCell, cellAction, saveNow]);

  // -------------------------------------------------------------------------
  // Copy
  // -------------------------------------------------------------------------
  const makeCopy = useCallback(async () => {
    if (!nb) return;
    try {
      await saveNow();
      const copy = await api<Notebook>(`/notebooks/${nb.id}/copy`, { method: 'POST' });
      navigate(`/notebooks/${copy.id}`);
      showToast({ text: 'Your copy is ready. Edit and run it as you like.' }, 3500);
    } catch (e) {
      showToast({ text: (e as Error).message });
    }
  }, [nb, navigate, saveNow, showToast]);

  const headings = useMemo(() => cells.flatMap((c) => (c.kind === 'text' ? headingsOf(c.source).map((h, nth) => ({ ...h, cellId: c.id, nth })) : [])), [cells]);
  // Same array while the headings stay the same (typing in a cell does not reset the scroll-spy)
  const headingsKey = JSON.stringify(headings);
  const outline = useMemo(() => headings, [headingsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll-spy: highlight the outline heading of the section on screen and keep it visible in the outline
  const loaded = nb !== null;
  useEffect(() => {
    const scroller = document.getElementById('notebook-scroll');
    if (!scroller || outline.length === 0) { setActiveHeading(null); return; }
    let frame = 0;
    const update = () => {
      frame = 0;
      const atBottom = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      const tops = outline.map((h) => headingElement(h.cellId, h.nth)?.getBoundingClientRect().top ?? null);
      setActiveHeading(activeHeadingIndex(tops, readingLine(scroller), atBottom));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // Content above the screen can grow without a scroll (an image loads, an output appears)
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    Array.from(scroller.children).forEach((child) => resized?.observe(child));
    return () => { scroller.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); resized?.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [outline, loaded, outlineOpen]);

  useEffect(() => {
    if (activeHeading === null) return;
    document.querySelectorAll<HTMLElement>(`[data-outline-index="${activeHeading}"]`).forEach((btn) => {
      const list = btn.closest<HTMLElement>('[data-outline-scroll]');
      if (!list) return;
      const b = btn.getBoundingClientRect(), l = list.getBoundingClientRect();
      if (b.top < l.top + 8) list.scrollTop -= l.top + 8 - b.top + l.height / 3;
      else if (b.bottom > l.bottom - 8) list.scrollTop += b.bottom - (l.bottom - 8) + l.height / 3;
    });
  }, [activeHeading, outlineDrawer, outlineOpen]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (loadError) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-xl mx-auto mt-16 text-center">
          <span aria-hidden="true" className="material-icons text-5xl text-gray-300">{loadError.status === 403 ? 'lock' : 'search_off'}</span>
          <h1 className="text-2xl font-extrabold text-gray-800 dark:text-gray-100 mt-2">{loadError.status === 403 ? 'This notebook is locked' : 'Notebook not found'}</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-2">{loadError.status === 403 ? 'It belongs to a lesson you have not reached yet.' : loadError.message}</p>
          <Link to="/notebooks" className="inline-block mt-6 px-5 py-2 rounded-full bg-primary font-bold text-gray-900 hover:bg-primary-dark hover:text-white">All notebooks</Link>
        </div>
      </div>
    );
  }
  if (!nb) return <div className="h-full flex items-center justify-center text-gray-400">Loading notebook…</div>;

  const editable = nb.can_edit;
  const ownTeacherNotebook = isAdmin && nb.owner.id === currentUser.id && nb.owner.is_teacher;
  const saveLabel: Record<SaveState, string> = { saved: 'Saved', dirty: 'Unsaved', saving: 'Saving…', conflict: 'Changed elsewhere', error: 'Not saved' };

  const outlinePanel = (
    <nav aria-label="Outline" className="text-sm">
      <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">Outline</div>
      {outline.length === 0 && <p className="text-gray-400 text-xs">Headings in text cells show up here.</p>}
      <ul className="space-y-0.5">
        {outline.map((h, k) => (
          <li key={`${h.cellId}-${k}`}>
            <button
              type="button"
              data-outline-index={k}
              aria-current={activeHeading === k ? 'location' : undefined}
              onClick={() => {
                setSelectedId(h.cellId); setOutlineDrawer(false);
                const target = headingElement(h.cellId, h.nth);
                const scroller = document.getElementById('notebook-scroll');
                if (!target || !scroller) return;
                // Just under the sticky toolbar, not behind it
                scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - readingLine(scroller) + 12, behavior: 'smooth' });
              }}
              className={`block w-full text-left truncate rounded px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-700 ${activeHeading === k ? 'text-primary-dark font-bold bg-primary/10' : 'text-gray-600 dark:text-gray-300'}`}
              style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );

  return (
    <div className={`h-full overflow-y-auto custom-scrollbar ${codeTheme === 'darcula' ? 'lp-darcula-scope' : ''}`} id="notebook-scroll">
      {/* Top bar */}
      <div className="sticky top-0 z-20 bg-white/95 dark:bg-gray-900/95 backdrop-blur border-b border-gray-100 dark:border-gray-800">
        <div className="mx-auto max-w-[1180px] px-3 py-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => (window.innerWidth < 1024 ? setOutlineDrawer(true) : (setOutlineOpen(!outlineOpen), writePref(OUTLINE_KEY, !outlineOpen)))} title="Outline" aria-label="Outline" className="w-9 h-9 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400">
            <span aria-hidden="true" className="material-icons">toc</span>
          </button>
          <div className="min-w-0 flex-1 basis-48">
            {editingTitle && editable ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => saveTitle(title)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(title); if (e.key === 'Escape') { setTitle(nb.title); setEditingTitle(false); } }}
                className="w-full text-lg font-extrabold text-gray-800 dark:text-gray-100 border-b-2 border-primary-dark outline-none bg-transparent"
                maxLength={255}
              />
            ) : (
              <h1 className={`text-lg font-extrabold text-gray-800 dark:text-gray-100 truncate ${editable ? 'cursor-text hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-1 -mx-1' : ''}`} onClick={() => editable && setEditingTitle(true)} title={editable ? 'Rename' : undefined}>
                {nb.title}
              </h1>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400">
              {nb.lesson
                ? <Link to={nb.lesson.course_id ? `/courses/${nb.lesson.course_id}?lesson=${nb.lesson.id}` : '#'} className="inline-flex items-center gap-1 hover:text-primary-dark"><span aria-hidden="true" className="material-icons text-sm">school</span>{nb.lesson.course_name ? `${nb.lesson.course_name} › ` : ''}{nb.lesson.title}</Link>
                : <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="material-icons text-sm">science</span>Playground</span>}
              {!nb.owner.is_teacher || nb.owner.id !== currentUser.id ? <span>by {nb.owner.id === currentUser.id ? 'you' : nb.owner.name}</span> : null}
              {nb.copied_from && (nb.copied_from.removed
                ? <span>Copy · original removed</span>
                : <span>Based on <Link to={`/notebooks/${nb.copied_from.id}`} className="underline hover:text-primary-dark">{nb.copied_from.title}</Link>{nb.copied_from.updated_since_copy && <strong className="text-amber-700 dark:text-amber-300"> · updated since you copied</strong>}</span>)}
              {ownTeacherNotebook && <span className={nb.published ? 'text-emerald-700 dark:text-emerald-300 font-semibold' : 'text-gray-400'}>{nb.published ? 'Published to students' : 'Draft (students cannot see it)'}</span>}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {editable && (
              <span className={`text-xs font-semibold px-2 ${saveState === 'conflict' || saveState === 'error' ? 'text-rose-600 dark:text-rose-400' : saveState === 'saved' ? 'text-gray-400' : 'text-amber-600 dark:text-amber-400'}`} aria-live="polite">
                {saveLabel[saveState]}
              </span>
            )}
            {nb.can_run && (
              <button type="button" onClick={runAll} disabled={runningIds.size > 0} className="h-9 px-3 rounded-lg bg-primary font-bold text-sm text-gray-900 hover:bg-primary-dark hover:text-white disabled:opacity-60 inline-flex items-center gap-1">
                <span aria-hidden="true" className="material-icons text-[20px]">fast_forward</span>Run all
              </button>
            )}
            {isAdmin && nb.can_run && (
              <button
                type="button"
                onClick={() => (liveSession ? endSession() : (setLiveSession(true), showToast({ text: 'Live session on: each run executes only that cell and variables stay between runs.' }, 4000)))}
                title="Live session: state is kept between runs (teacher only, 10 min idle timeout)"
                className={`h-9 px-3 rounded-lg text-sm font-bold inline-flex items-center gap-1 ${liveSession ? 'bg-sky-100 dark:bg-sky-900/40 text-sky-800 dark:text-sky-300' : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300'}`}
              >
                <span aria-hidden="true" className="material-icons text-[20px]">{liveSession ? 'sensors' : 'sensors_off'}</span>{liveSession ? 'Live session' : 'Live'}
              </button>
            )}
            {!editable && (
              <button type="button" onClick={makeCopy} className="h-9 px-3 rounded-lg bg-gray-900 text-white font-bold text-sm hover:bg-gray-700 inline-flex items-center gap-1">
                <span aria-hidden="true" className="material-icons text-[20px]">content_copy</span>Copy to edit
              </button>
            )}
            {editable && nb.copied_from && nb.copied_from.updated_since_copy && nb.copied_from.id && (
              <button type="button" onClick={() => navigate(`/notebooks/${nb.copied_from!.id}`)} className="h-9 px-3 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/30 text-amber-800 dark:text-amber-300 font-bold text-sm">See the new version</button>
            )}
            <button type="button" onClick={() => setPresenting(true)} title="Present" aria-label="Present" className="w-9 h-9 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300">
              <span aria-hidden="true" className="material-icons">slideshow</span>
            </button>
            {ownTeacherNotebook && (
              <button type="button" onClick={() => setDialog('copies')} title="Student copies" aria-label="Student copies" className="h-9 px-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm font-bold inline-flex items-center gap-1">
                <span aria-hidden="true" className="material-icons text-[20px]">group</span>{nb.copies_count || 0}
              </button>
            )}
            <a href={apiUrl(`/notebooks/${nb.id}/export`)} title="Download as Markdown" aria-label="Download as Markdown" className="w-9 h-9 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300">
              <span aria-hidden="true" className="material-icons">download</span>
            </a>
            {editable && (
              <button type="button" onClick={() => setDialog('settings')} title="Settings" aria-label="Settings" className="w-9 h-9 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300">
                <span aria-hidden="true" className="material-icons">tune</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setCodeTheme(codeTheme === 'darcula' ? 'default' : 'darcula')}
              aria-pressed={codeTheme === 'darcula'}
              title={codeTheme === 'darcula' ? 'Code theme: Darcula (click for the default)' : 'Code theme: default (click for Darcula)'}
              aria-label="Darcula code theme"
              className={`h-9 px-2 rounded-lg text-sm font-bold inline-flex items-center gap-1 ${codeTheme === 'darcula' ? 'bg-[#2b2b2b] text-[#cc7832] hover:bg-[#3c3f41]' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
            >
              <span aria-hidden="true" className="material-icons text-[20px]">contrast</span>
              <span className="hidden lg:inline">Darcula</span>
            </button>
            <button type="button" onClick={() => setDialog('shortcuts')} title="Keyboard shortcuts (H)" aria-label="Keyboard shortcuts" className="w-9 h-9 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300">
              <span aria-hidden="true" className="material-icons">keyboard</span>
            </button>
          </div>
        </div>
        {(saveState === 'conflict' || runnerNotice || !editable) && (
          <div className="mx-auto max-w-[1180px] px-3 pb-2 space-y-1">
            {saveState === 'conflict' && (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-rose-50 dark:bg-rose-900/30 border border-rose-200 dark:border-rose-800 px-3 py-2 text-sm text-rose-900 dark:text-rose-300">
                <span>This notebook was changed in another tab or window. Your latest edits here are not saved.</span>
                <button type="button" onClick={load} className="font-bold underline shrink-0">Reload</button>
              </div>
            )}
            {runnerNotice && <div className="rounded-lg bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm text-amber-900 dark:text-amber-300">{runnerNotice}</div>}
            {!editable && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-800 px-3 py-2 text-sm text-sky-900 dark:text-sky-300">
                <span>{nb.owner.is_teacher ? "This is the teacher's notebook. Copy it to edit and run the code." : `${nb.owner.name}'s notebook, read-only.`}</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mx-auto max-w-[1180px] px-3 flex gap-6">
        {outlineOpen && (
          <aside className="hidden lg:block w-56 shrink-0">
            <div data-outline-scroll className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto py-4">{outlinePanel}</div>
          </aside>
        )}
        <div className="min-w-0 flex-1 max-w-[900px] mx-auto py-6 pb-40">
          {editable && <AddCellBar onAdd={(k) => addCell(0, k)} always={cells.length === 0} />}
          {cells.map((cell, i) => (
            <React.Fragment key={cell.id}>
              <CellView
                ref={(h) => { if (h) cellRefs.current.set(cell.id, h); else cellRefs.current.delete(cell.id); }}
                cell={cell}
                output={outputs[cell.id]}
                selected={selectedId === cell.id}
                editing={editingId === cell.id}
                running={runningIds.has(cell.id)}
                queuedAhead={queuedAhead}
                flash={flash.has(cell.id)}
                editable={editable}
                runnable={nb.can_run}
                isFirst={i === 0}
                isLast={i === cells.length - 1}
                onSelect={() => setSelectedId(cell.id)}
                onEdit={() => { setSelectedId(cell.id); setEditingId(cell.id); }}
                onStopEditing={() => setEditingId((e) => (e === cell.id ? null : e))}
                onChange={(src) => setSource(cell.id, src)}
                onInputChange={(input) => setInput(cell.id, input)}
                onRun={(how) => runCell(cell.id, how)}
                onAction={(a) => cellAction(cell.id, a)}
                onClearOutput={() => clearOutput(cell.id)}
                onFiles={(files) => uploadImages(cell.id, files)}
                dragging={dragId === cell.id}
                dropPosition={dragId && dragId !== cell.id && dropAt?.id === cell.id ? dropAt.position : null}
                onDragStart={editable ? () => { setDragId(cell.id); setEditingId(null); } : undefined}
                onDragEnd={() => { setDragId(null); setDropAt(null); }}
                onDragOverCell={editable ? (position) => {
                  if (!dropAt || dropAt.id !== cell.id || dropAt.position !== position) setDropAt({ id: cell.id, position });
                } : undefined}
                onDropCell={editable ? (position) => {
                  if (dragId) moveCellTo(dragId, cell.id, position);
                  setDragId(null);
                  setDropAt(null);
                } : undefined}
              />
              {editable && <AddCellBar onAdd={(k) => addCell(i + 1, k)} />}
            </React.Fragment>
          ))}
          {cells.length === 0 && !editable && <p className="text-center text-gray-400 py-16">This notebook is empty.</p>}
        </div>
      </div>

      {outlineDrawer && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOutlineDrawer(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div data-outline-scroll className="absolute left-0 top-0 bottom-0 w-72 bg-white dark:bg-gray-800 p-4 overflow-y-auto shadow-xl" onClick={(e) => e.stopPropagation()}>{outlinePanel}</div>
        </div>
      )}

      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files || [])];
          e.target.value = '';
          if (imageTarget.current && files.length) uploadImages(imageTarget.current, files);
        }}
      />

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 rounded-xl bg-gray-900 text-white px-4 py-3 shadow-lg text-sm max-w-[90vw]" role="status">
          <span>{toast.text}</span>
          {toast.action && <button type="button" onClick={() => { toast.action!.run(); setToast(null); }} className="font-bold text-primary">{toast.action.label}</button>}
        </div>
      )}

      {presenting && (
        <PresentMode
          title={nb.title}
          cells={cells}
          outputs={outputs}
          runningIds={runningIds}
          canRun={nb.can_run}
          startAt={selectedId}
          onRun={(cid, scratch) => runCell(cid, 'stay', scratch)}
          onClose={() => setPresenting(false)}
        />
      )}

      {dialog === 'shortcuts' && (
        <Modal title="Keyboard shortcuts" onClose={() => setDialog(null)}>
          <table className="w-full text-sm">
            <tbody>
              {SHORTCUTS.map(([k, d]) => (
                <tr key={k} className="border-b border-gray-50 last:border-0">
                  <td className="py-1.5 pr-4 font-mono text-xs whitespace-nowrap text-gray-700 dark:text-gray-200">{k}</td>
                  <td className="py-1.5 text-gray-600 dark:text-gray-300">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-400 mt-3">Single-letter keys work when no cell is being edited (press Esc first).</p>
        </Modal>
      )}

      {dialog === 'settings' && (
        <SettingsDialog
          nb={nb}
          isAdmin={isAdmin}
          onClose={() => setDialog(null)}
          onSaved={(patch, revision) => { revisionRef.current = revision; setNb({ ...nb, ...patch }); if (patch.title) setTitle(patch.title); }}
          onDeleted={() => navigate('/notebooks')}
          enqueue={enqueue}
        />
      )}

      {dialog === 'copies' && <CopiesDialog notebookId={nb.id} onClose={() => setDialog(null)} />}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Settings: title, description; teachers also attach to a lesson and publish
// ---------------------------------------------------------------------------
interface LessonOption { id: number; label: string }

const SettingsDialog: React.FC<{
  nb: Notebook;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: (patch: Partial<Notebook>, revision: number) => void;
  onDeleted: () => void;
  enqueue: (job: () => Promise<void>) => Promise<void>;
}> = ({ nb, isAdmin, onClose, onSaved, onDeleted, enqueue }) => {
  const [title, setTitle] = useState(nb.title);
  const [description, setDescription] = useState(nb.description);
  const [lessonId, setLessonId] = useState<number | null>(nb.lesson ? nb.lesson.id : null);
  const [published, setPublished] = useState(nb.published);
  const [lessons, setLessons] = useState<LessonOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canAttach = isAdmin && nb.owner.is_teacher;

  useEffect(() => {
    if (!canAttach) return;
    (async () => {
      try {
        const courses = await api<{ id: number; name: string }[]>('/courses');
        const details = await Promise.all(courses.map((c) => api<CourseDetail>(`/courses/${c.id}`)));
        setLessons(details.flatMap((d) => d.phases.flatMap((p) => p.lessons.map((l) => ({ id: l.id, label: `${d.name} › ${p.name} › ${l.title}` })))));
      } catch { setLessons([]); }
    })();
  }, [canAttach]);

  const save = () => enqueue(async () => {
    setError(null);
    try {
      const body: Record<string, unknown> = { title, description };
      if (canAttach) { body.lessonId = lessonId; body.published = published; }
      const r = await api<{ revision: number }>(`/notebooks/${nb.id}`, { method: 'PUT', json: body });
      const fresh = await api<Notebook>(`/notebooks/${nb.id}`);
      onSaved({ title: fresh.title, description: fresh.description, lesson: fresh.lesson, kind: fresh.kind, published: fresh.published }, r.revision);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  });

  const remove = async () => {
    try { await api(`/notebooks/${nb.id}`, { method: 'DELETE' }); onDeleted(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <Modal title="Notebook settings" onClose={onClose}>
      <div className="space-y-4">
        <label className="block">
          <span className="text-sm font-bold text-gray-700 dark:text-gray-200">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} className="mt-1 w-full rounded-lg border-gray-300 dark:border-gray-600 focus:border-primary-dark focus:ring-primary-dark bg-white dark:bg-gray-900 dark:text-gray-100" />
        </label>
        <label className="block">
          <span className="text-sm font-bold text-gray-700 dark:text-gray-200">Description</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={4000} className="mt-1 w-full rounded-lg border-gray-300 dark:border-gray-600 focus:border-primary-dark focus:ring-primary-dark bg-white dark:bg-gray-900 dark:text-gray-100" />
        </label>
        {canAttach && (
          <>
            <label className="block">
              <span className="text-sm font-bold text-gray-700 dark:text-gray-200">Lesson</span>
              <select value={lessonId ?? ''} onChange={(e) => setLessonId(e.target.value ? Number(e.target.value) : null)} className="mt-1 w-full rounded-lg border-gray-300 dark:border-gray-600 focus:border-primary-dark focus:ring-primary-dark bg-white dark:bg-gray-900 dark:text-gray-100" disabled={lessons === null}>
                <option value="">Not attached (playground)</option>
                {(lessons || []).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <span className="text-xs text-gray-500 dark:text-gray-400">Attached notebooks show inside the lesson and follow its phase gates.</span>
            </label>
            <label className="flex items-start gap-3">
              <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} className="mt-1 rounded text-primary-dark focus:ring-primary-dark" />
              <span>
                <span className="text-sm font-bold text-gray-700 dark:text-gray-200">Published to students</span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">Students can open it read-only and copy it. Unpublished notebooks are yours only.</span>
              </span>
            </label>
          </>
        )}
        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="flex items-center justify-between pt-2">
          {confirmDelete
            ? <span className="flex items-center gap-2 text-sm"><span className="text-rose-700 dark:text-rose-300 font-semibold">Delete for good?</span><button type="button" onClick={remove} className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-bold">Delete</button><button type="button" onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">Keep</button></span>
            : <button type="button" onClick={() => setConfirmDelete(true)} className="text-sm font-bold text-rose-600 dark:text-rose-400 hover:underline">Delete notebook</button>}
          <button type="button" onClick={save} className="px-5 py-2 rounded-full bg-primary font-bold text-gray-900 hover:bg-primary-dark hover:text-white">Save</button>
        </div>
      </div>
    </Modal>
  );
};

const CopiesDialog: React.FC<{ notebookId: number; onClose: () => void }> = ({ notebookId, onClose }) => {
  const [rows, setRows] = useState<NotebookSummary[] | null>(null);
  useEffect(() => { api<NotebookSummary[]>(`/notebooks/${notebookId}/copies`).then(setRows).catch(() => setRows([])); }, [notebookId]);
  return (
    <Modal title="Student copies" onClose={onClose} wide>
      {rows === null && <p className="text-gray-400 text-sm">Loading…</p>}
      {rows && rows.length === 0 && <p className="text-gray-500 dark:text-gray-400 text-sm">No student has copied this notebook yet.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {rows.map((r) => (
            <li key={r.id} className="py-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-bold text-gray-800 dark:text-gray-100 truncate">{r.owner.name}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Last run {timeAgo(r.last_run_at)} · edited {timeAgo(r.updated_at)}</div>
              </div>
              <Link to={`/notebooks/${r.id}`} onClick={onClose} className="shrink-0 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-bold hover:border-primary-dark">Open read-only</Link>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
};
