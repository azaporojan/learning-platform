import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, StateEffect, StateField, Compartment, Extension, Prec, Annotation } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder as placeholderExt, Decoration, DecorationSet, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { classHighlighter } from '@lezer/highlight';
import { java } from '@codemirror/lang-java';
import { markdown } from '@codemirror/lang-markdown';
import { javaCompletions } from './javaCompletions';

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
