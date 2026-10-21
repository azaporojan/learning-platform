import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { Cell, CellOutput } from './types';
import { CodeEditor, CodeEditorHandle } from './CodeEditor';
import { NotebookMarkdown } from './NotebookMarkdown';
import { CellOutputView } from './CellOutputView';

export type CellAction = 'up' | 'down' | 'convert' | 'delete' | 'image';

// Cells move by dragging their handle; the payload type keeps a dragged cell apart from dropped files
export const CELL_DRAG_TYPE = 'application/x-lp-cell';
export type DropPosition = 'before' | 'after' | null;

export interface CellViewHandle {
  focusEditor: () => void;
  insert: (text: string) => void;
  replace: (search: string, replacement: string) => void;
}

interface CellViewProps {
  cell: Cell;
  output?: CellOutput;
  selected: boolean;
  editing: boolean; // text cells: source shown; code cells: editor focused
  running: boolean;
  queuedAhead: number; // queue position while waiting for a sandbox (1 = next), 0 = not waiting
  flash: boolean;
  editable: boolean;
  runnable: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onStopEditing: () => void;
  onChange: (source: string) => void;
  onRun: (how: 'advance' | 'stay' | 'insert') => void;
  onAction: (action: CellAction) => void;
  onClearOutput: () => void;
  onFiles: (files: File[]) => void;
  dragging?: boolean; // this cell is the one being dragged
  dropPosition?: DropPosition; // where a dragged cell would land relative to this one
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOverCell?: (position: 'before' | 'after') => void;
  onDropCell?: (position: 'before' | 'after') => void;
}

const ToolButton: React.FC<{ icon: string; title: string; onClick: () => void; disabled?: boolean; danger?: boolean }> = ({ icon, title, onClick, disabled, danger }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    disabled={disabled}
    onMouseDown={(e) => e.preventDefault()}
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    className={`w-7 h-7 rounded-md flex items-center justify-center text-gray-500 disabled:opacity-30 ${danger ? 'hover:bg-rose-50 hover:text-rose-600' : 'hover:bg-gray-100 hover:text-gray-800'}`}
  >
    <span aria-hidden="true" className="material-icons text-[18px] leading-none">{icon}</span>
  </button>
);

export const CellView = forwardRef<CellViewHandle, CellViewProps>(function CellView(p, ref) {
  const editor = useRef<CodeEditorHandle>(null);
  useImperativeHandle(ref, () => ({
    focusEditor: () => editor.current?.focus(),
    insert: (text) => editor.current?.insert(text),
    replace: (a, b) => editor.current?.replace(a, b),
  }), []);

  const isCode = p.cell.kind === 'code';
  const root = useRef<HTMLDivElement>(null);
  const isCellDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(CELL_DRAG_TYPE);
  const half = (e: React.DragEvent): 'before' | 'after' => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
  };
  const errorLine = p.output && p.output.status === 'error' && p.output.error ? p.output.error.line : null;
  const count = p.output && p.output.executionCount;

  const gutter = isCode ? (
    <div className="w-10 sm:w-12 shrink-0 flex flex-col items-center pt-2 gap-1 select-none">
      {p.runnable ? (
        <button
          type="button"
          title="Run this cell and the cells above it (Shift+Enter)"
          aria-label="Run cell"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); p.onRun('stay'); }}
          disabled={p.running}
          className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${p.running ? 'text-primary-dark' : 'text-gray-400 hover:text-white hover:bg-primary-dark'}`}
        >
          {p.running
            ? <span className="lp-spinner" aria-hidden="true" />
            : <span aria-hidden="true" className="material-icons text-[22px] leading-none">play_arrow</span>}
        </button>
      ) : <div className="w-8 h-8" />}
      <span className="text-[11px] text-gray-400 font-mono tabular-nums">
        {p.running && p.queuedAhead > 0 ? '' : (count ? `[${count}]` : '[ ]')}
      </span>
    </div>
  ) : <div className="w-3 sm:w-12 shrink-0" />;

  return (
    <div
      ref={root}
      className={`lp-cell group relative flex rounded-xl transition-shadow ${p.selected ? 'lp-cell-selected' : ''} ${p.running ? 'lp-cell-running' : ''} ${p.dragging ? 'opacity-40' : ''}`}
      onMouseDown={() => { if (!p.selected) p.onSelect(); }}
      data-cell-id={p.cell.id}
      // Only cell drags are handled here; dropped image files go on to the text editor as before
      onDragOver={(e) => {
        if (!p.onDragOverCell || !isCellDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        p.onDragOverCell(half(e));
      }}
      onDrop={(e) => {
        if (!p.onDropCell || !isCellDrag(e)) return;
        e.preventDefault();
        p.onDropCell(half(e));
      }}
    >
      {p.dropPosition && (
        <div aria-hidden="true" className={`pointer-events-none absolute left-10 right-2 h-1 rounded-full bg-sky-500 z-20 ${p.dropPosition === 'before' ? '-top-3.5' : '-bottom-3.5'}`} />
      )}
      <div className={`absolute left-0 top-2 bottom-2 w-1 rounded-full ${p.selected ? (p.editing ? 'bg-primary-dark' : 'bg-sky-400') : 'bg-transparent'}`} />
      {gutter}
      <div className="min-w-0 flex-1 py-1 pr-2">
        {p.running && p.queuedAhead > 0 && (
          <div className="text-xs font-semibold text-amber-700 mb-1">
            Waiting for a free sandbox{p.queuedAhead > 1 ? `, ${p.queuedAhead - 1} ahead` : ''}…
          </div>
        )}
        {isCode ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden focus-within:border-primary-dark focus-within:bg-white transition-colors">
            <CodeEditor
              ref={editor}
              value={p.cell.source}
              language="java"
              readOnly={!p.editable}
              errorLine={errorLine}
              placeholder={p.editable ? 'Java code. Shift+Enter runs it.' : ''}
              onChange={p.onChange}
              onFocus={p.onEdit}
              onBlur={p.onStopEditing}
              onEscape={p.onStopEditing}
              onRun={p.runnable ? p.onRun : undefined}
            />
          </div>
        ) : p.editing && p.editable ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-primary-dark bg-white overflow-hidden min-w-0">
              <CodeEditor
                ref={editor}
                value={p.cell.source}
                language="markdown"
                autoFocus
                placeholder="Markdown: # heading, **bold**, - list, > **Note** callout, ```mermaid diagram. Paste or drop images."
                onChange={p.onChange}
                onEscape={p.onStopEditing}
                onBlur={p.onStopEditing}
                onRun={(how) => { p.onStopEditing(); p.onRun(how); }}
                onFiles={p.onFiles}
              />
            </div>
            <div className="min-w-0 rounded-lg border border-dashed border-gray-200 px-4 py-2 max-h-[70vh] overflow-y-auto">
              {p.cell.source.trim() ? <NotebookMarkdown source={p.cell.source} /> : <p className="text-sm text-gray-400 italic">Preview</p>}
            </div>
          </div>
        ) : (
          <div
            className="px-2 py-1 min-h-[2.5rem]"
            onDoubleClick={() => { if (p.editable) p.onEdit(); }}
            title={p.editable ? 'Double-click to edit' : undefined}
          >
            {p.cell.source.trim()
              ? <NotebookMarkdown source={p.cell.source} />
              : <p className="text-sm text-gray-400 italic py-2">{p.editable ? 'Empty text cell. Double-click to write.' : ''}</p>}
          </div>
        )}
        {isCode && p.output && (
          <div className="mt-1 rounded-lg bg-white border border-gray-100">
            <CellOutputView output={p.output} flash={p.flash} onClear={p.editable ? p.onClearOutput : undefined} />
          </div>
        )}
      </div>
      {p.editable && (
        <div className={`absolute -top-3 right-3 z-10 flex items-center gap-0.5 rounded-lg border border-gray-200 bg-white shadow-sm px-1 py-0.5 transition-opacity ${p.selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
          {!isCode && !p.editing && <ToolButton icon="edit" title="Edit (Enter)" onClick={p.onEdit} />}
          {!isCode && <ToolButton icon="image" title="Insert an image (or paste / drop one while editing)" onClick={() => p.onAction('image')} />}
          {p.onDragStart && (
            <span
              draggable
              title="Drag to move"
              aria-label="Drag to move the cell"
              onMouseDown={(e) => e.stopPropagation()}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData(CELL_DRAG_TYPE, p.cell.id);
                e.dataTransfer.setData('text/plain', '');
                if (root.current) e.dataTransfer.setDragImage(root.current, 24, 24);
                p.onDragStart!();
              }}
              onDragEnd={() => p.onDragEnd && p.onDragEnd()}
              className="w-7 h-7 rounded-md flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-800 cursor-grab active:cursor-grabbing"
            >
              <span aria-hidden="true" className="material-icons text-[18px] leading-none">drag_indicator</span>
            </span>
          )}
          <ToolButton icon="arrow_upward" title="Move up" onClick={() => p.onAction('up')} disabled={p.isFirst} />
          <ToolButton icon="arrow_downward" title="Move down" onClick={() => p.onAction('down')} disabled={p.isLast} />
          <ToolButton icon={isCode ? 'notes' : 'code'} title={isCode ? 'Convert to text (M)' : 'Convert to code (Y)'} onClick={() => p.onAction('convert')} />
          <ToolButton icon="delete_outline" title="Delete (D D)" onClick={() => p.onAction('delete')} danger />
        </div>
      )}
    </div>
  );
});

// "+ Code / + Text" between cells, shown on hover (Colab style)
export const AddCellBar: React.FC<{ onAdd: (kind: 'code' | 'text') => void; always?: boolean }> = ({ onAdd, always }) => (
  <div className={`group/add relative h-6 flex items-center justify-center ${always ? '' : ''}`}>
    <div className={`absolute inset-x-12 top-1/2 h-px bg-gray-200 ${always ? 'opacity-100' : 'opacity-0 group-hover/add:opacity-100'} transition-opacity`} />
    <div className={`relative flex gap-2 ${always ? 'opacity-100' : 'opacity-0 group-hover/add:opacity-100 focus-within:opacity-100'} transition-opacity`}>
      {(['code', 'text'] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          onClick={() => onAdd(kind)}
          className="flex items-center gap-1 rounded-full border border-gray-200 bg-white px-3 py-0.5 text-xs font-bold text-gray-600 shadow-sm hover:border-primary-dark hover:text-primary-dark"
        >
          <span aria-hidden="true" className="material-icons text-sm leading-none">add</span>{kind === 'code' ? 'Code' : 'Text'}
        </button>
      ))}
    </div>
  </div>
);
