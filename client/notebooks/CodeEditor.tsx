import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, EditorSelection, StateEffect, StateField, Compartment, Extension, Prec, Annotation } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder as placeholderExt, Decoration, DecorationSet, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, copyLineDown, deleteLine, moveLineUp, moveLineDown } from '@codemirror/commands';
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, snippet } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { classHighlighter } from '@lezer/highlight';
import { java } from '@codemirror/lang-java';
import { markdown } from '@codemirror/lang-markdown';
import { javaCompletions } from './javaCompletions';
import { formatJava } from './javaFormat';

export interface CodeEditorHandle {
  focus: () => void;
  blur: () => void;
  insert: (text: string) => void;
  replace: (search: string, replacement: string) => void;
}

interface CodeEditorProps {
  value: string;
  language: 'java' | 'markdown';
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onRun?: (how: 'advance' | 'stay' | 'insert') => void; // Shift/Ctrl/Alt+Enter
  onEscape?: () => void;
  onFiles?: (files: File[]) => void; // pasted or dropped images (text cells)
  errorLine?: number | null;
  readOnly?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}

// Marks changes that came from outside (props), so they are not reported back as edits
const external = Annotation.define<boolean>();

// Red background on the line a compile or runtime error points at
const setErrorLine = StateEffect.define<number | null>();
const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrorLine)) {
        const line = e.value;
        if (!line || line > tr.state.doc.lines) return Decoration.none;
        return Decoration.set([Decoration.line({ class: 'cm-error-line' }).range(tr.state.doc.line(line).from)]);
      }
    }
    return tr.docChanged ? Decoration.none : deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// IntelliJ IDEA habits: Ctrl+Alt+L reformat, Ctrl+D duplicate, Ctrl+Y delete line, live templates
// on Tab (sout, souf, serr, fori, iter), Shift+Alt+Up/Down move the line
// ---------------------------------------------------------------------------
const TEMPLATES: Record<string, string> = {
  sout: 'System.out.println(${});',
  souf: 'System.out.printf("${}%n");',
  serr: 'System.err.println(${});',
  fori: 'for (int ${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}',
  iter: 'for (var ${item} : ${items}) {\n\t${}\n}',
};

// Tab right after a template's abbreviation expands it; any other Tab indents as before
const expandTemplate = (view: EditorView): boolean => {
  const sel = view.state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const pos = sel.main.head;
  const line = view.state.doc.lineAt(pos);
  const m = line.text.slice(0, pos - line.from).match(/(^|[^\w$.])([a-z]+)$/);
  if (!m || !TEMPLATES[m[2]]) return false;
  const from = pos - m[2].length;
  snippet(TEMPLATES[m[2]])(view, { label: m[2] }, from, pos);
  return true;
};

// Reformats the cell, or only the selected lines; the cursor stays on its line
const reformat = (view: EditorView): boolean => {
  const { state } = view;
  const sel = state.selection.main;
  const whole = sel.empty;
  const fromLine = state.doc.lineAt(whole ? 0 : sel.from);
  const toLine = state.doc.lineAt(whole ? state.doc.length : sel.to);
  const original = state.sliceDoc(fromLine.from, toLine.to);
  let formatted = formatJava(original);
  if (!whole) {
    // A part keeps the indentation it starts with
    const base = (fromLine.text.match(/^\s*/) || [''])[0];
    formatted = formatted.split('\n').map((l) => (l ? base + l : l)).join('\n');
  }
  if (formatted === original) return true;
  const cursorLine = state.doc.lineAt(sel.head).number - fromLine.number;
  view.dispatch({ changes: { from: fromLine.from, to: toLine.to, insert: formatted }, userEvent: 'input.format' });
  const target = view.state.doc.line(Math.min(view.state.doc.lines, fromLine.number + Math.max(0, cursorLine)));
  const indent = (target.text.match(/^\s*/) || [''])[0].length;
  view.dispatch({ selection: { anchor: target.from + indent } });
  return true;
};

// Ctrl+D: the line(s) under the cursor, or the selection, once more right after
const duplicate = (view: EditorView): boolean => {
  const { state } = view;
  if (state.selection.ranges.every((r) => r.empty)) return copyLineDown(view);
  view.dispatch(state.changeByRange((r) => {
    const text = state.sliceDoc(r.from, r.to);
    return { changes: { from: r.to, insert: text }, range: EditorSelection.range(r.to, r.to + text.length) };
  }), { userEvent: 'input.duplicate' });
  return true;
};

const intellijKeys = (isJava: boolean) => Prec.high(keymap.of([
  { key: 'Mod-d', run: duplicate, preventDefault: true },
  { key: 'Mod-y', run: deleteLine, preventDefault: true },
  { key: 'Shift-Alt-ArrowUp', run: moveLineUp },
  { key: 'Shift-Alt-ArrowDown', run: moveLineDown },
  ...(isJava ? [
    { key: 'Mod-Alt-l', run: reformat, preventDefault: true },
    { key: 'Tab', run: expandTemplate },
  ] : []),
]));

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const editable = useRef(new Compartment());

  useImperativeHandle(ref, () => ({
    focus: () => view.current && view.current.focus(),
    blur: () => view.current && view.current.contentDOM.blur(),
    insert: (text: string) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    },
    // Swaps a placeholder (e.g. an image still uploading) wherever it is now
    replace: (search: string, replacement: string) => {
      const v = view.current;
      if (!v) return;
      const at = v.state.doc.toString().indexOf(search);
      if (at !== -1) v.dispatch({ changes: { from: at, to: at + search.length, insert: replacement } });
    },
  }), []);

  useEffect(() => {
    if (!host.current) return undefined;
    const runKeys = Prec.highest(keymap.of([
      { key: 'Shift-Enter', run: () => { latest.current.onRun?.('advance'); return Boolean(latest.current.onRun); } },
      { key: 'Mod-Enter', run: () => { latest.current.onRun?.('stay'); return Boolean(latest.current.onRun); } },
      { key: 'Alt-Enter', run: () => { latest.current.onRun?.('insert'); return Boolean(latest.current.onRun); } },
      { key: 'Escape', run: (v) => { if (!latest.current.onEscape) return false; v.contentDOM.blur(); latest.current.onEscape(); return true; } },
    ]));
    const isJava = props.language === 'java';
    const extensions: Extension[] = [
      runKeys,
      intellijKeys(isJava),
      history(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      EditorState.allowMultipleSelections.of(true),
      indentUnit.of('    '),
      EditorState.tabSize.of(4),
      syntaxHighlighting(classHighlighter),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      errorLineField,
      editable.current.of([EditorView.editable.of(!props.readOnly), EditorState.readOnly.of(Boolean(props.readOnly))]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) latest.current.onChange(u.state.doc.toString());
        if (u.focusChanged) (u.view.hasFocus ? latest.current.onFocus : latest.current.onBlur)?.();
      }),
      EditorView.domEventHandlers({
        paste: (e) => {
          const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
          if (!files.length || !latest.current.onFiles) return false;
          e.preventDefault();
          latest.current.onFiles(files);
          return true;
        },
        drop: (e, v) => {
          const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
          if (!files.length || !latest.current.onFiles) return false;
          e.preventDefault();
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos !== null) v.dispatch({ selection: { anchor: pos } });
          latest.current.onFiles(files);
          return true;
        },
      }),
    ];
    if (isJava) {
      extensions.push(java(), lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), autocompletion({ override: [javaCompletions], icons: false }));
    } else {
      extensions.push(markdown(), EditorView.lineWrapping);
    }
    if (props.placeholder) extensions.push(placeholderExt(props.placeholder));
    const v = new EditorView({ parent: host.current, state: EditorState.create({ doc: props.value, extensions }) });
    view.current = v;
    if (props.autoFocus) { v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); }
    return () => { v.destroy(); view.current = null; };
    // The editor is created once per cell; later prop changes are applied below
  }, [props.language]); // eslint-disable-line react-hooks/exhaustive-deps

  // Outside changes (reload, undo of a cell operation) replace the text
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value }, annotations: external.of(true) });
    }
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setErrorLine.of(props.errorLine || null) });
  }, [props.errorLine]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorView.editable.of(!props.readOnly), EditorState.readOnly.of(Boolean(props.readOnly))]) });
  }, [props.readOnly]);

  return <div ref={host} className={`lp-cm ${props.language === 'java' ? 'lp-cm-code' : 'lp-cm-text'}`} />;
});
