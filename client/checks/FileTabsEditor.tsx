import React, { useEffect, useState } from 'react';
import { CodeEditor } from '../notebooks/CodeEditor';
import { CodeFile } from './types';

const SAFE_PATH = /^[A-Za-z0-9_$-]+(\/[A-Za-z0-9_$-]+)*\.java$/;

// Several Java files as tabs over one editor. With allowStructure the user adds, renames and removes files.
export const FileTabsEditor: React.FC<{
  files: CodeFile[];
  onChange?: (files: CodeFile[]) => void;
  readOnly?: boolean;
  allowStructure?: boolean;
  newFileName?: string;
}> = ({ files, onChange, readOnly, allowStructure, newFileName = 'Main.java' }) => {
  const [active, setActive] = useState(0);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => { if (active >= files.length) setActive(Math.max(0, files.length - 1)); }, [files.length, active]);

  const update = (i: number, patch: Partial<CodeFile>) => onChange?.(files.map((f, k) => (k === i ? { ...f, ...patch } : f)));
  const add = () => {
    let base = newFileName.replace(/\.java$/, '');
    let n = 1;
    let p = `${base}.java`;
    while (files.some((f) => f.path === p)) { n += 1; p = `${base}${n}.java`; }
    onChange?.([...files, { path: p, content: '' }]);
    setActive(files.length);
    setRenaming(files.length);
    setName(p);
  };
  const commitRename = (i: number) => {
    const p = name.trim();
    if (!SAFE_PATH.test(p)) { setNameError('Use a path like shop/Calculator.java'); return; }
    if (files.some((f, k) => k !== i && f.path === p)) { setNameError('That file already exists'); return; }
    update(i, { path: p });
    setRenaming(null);
    setNameError(null);
  };

  const current = files[active];
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden bg-white dark:bg-gray-800">
      <div className="flex items-center gap-1 overflow-x-auto bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-2 pt-2">
        {files.map((f, i) => (
          <div key={i} className={`flex items-center rounded-t-lg border border-b-0 text-xs font-mono ${i === active ? 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100'}`}>
            {renaming === i ? (
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => commitRename(i)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(i); if (e.key === 'Escape') { setRenaming(null); setNameError(null); } }}
                className="px-2 py-1 w-48 text-xs font-mono border-0 focus:ring-1 focus:ring-primary-dark rounded bg-white dark:bg-gray-900 dark:text-gray-100"
                aria-label="File path"
              />
            ) : (
              <button type="button" onClick={() => setActive(i)} onDoubleClick={() => { if (allowStructure) { setRenaming(i); setName(f.path); } }} className="px-3 py-1.5" title={allowStructure ? 'Double-click to rename' : f.path}>
                {f.path}
              </button>
            )}
            {allowStructure && files.length > 1 && i === active && renaming !== i && (
              <button type="button" onClick={() => onChange?.(files.filter((_, k) => k !== i))} aria-label={`Remove ${f.path}`} className="pr-2 text-gray-400 hover:text-rose-600 dark:hover:text-rose-400">
                <span aria-hidden="true" className="material-icons text-[14px] align-middle">close</span>
              </button>
            )}
          </div>
        ))}
        {allowStructure && (
          <button type="button" onClick={add} className="ml-1 mb-1 px-2 py-1 rounded-lg text-xs font-bold text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 inline-flex items-center gap-0.5">
            <span aria-hidden="true" className="material-icons text-[16px]">add</span>File
          </button>
        )}
      </div>
      {nameError && <div className="px-3 py-1 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/30">{nameError}</div>}
      {current ? (
        <div className="max-h-[420px] overflow-y-auto">
          <CodeEditor key={`${active}-${current.path}`} value={current.content} language="java" readOnly={readOnly} onChange={(v) => update(active, { content: v })} placeholder={readOnly ? '' : 'Your Java code'} />
        </div>
      ) : (
        <p className="p-4 text-sm text-gray-400">No files yet.</p>
      )}
    </div>
  );
};
