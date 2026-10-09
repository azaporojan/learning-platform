import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LessonFile } from '../types';
import { apiUrl } from '../config';

const ACCEPT = '.pdf,.doc,.docx,.ppt,.pptx,.txt,.md';

export const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Icon + colour per file type
export const fileStyle = (ext: string): { icon: string; color: string } => {
  switch (ext) {
    case 'pdf': return { icon: 'picture_as_pdf', color: 'text-red-500' };
    case 'doc': case 'docx': return { icon: 'description', color: 'text-blue-600' };
    case 'ppt': case 'pptx': return { icon: 'slideshow', color: 'text-orange-500' };
    case 'md': return { icon: 'article', color: 'text-gray-700 dark:text-gray-300' };
    default: return { icon: 'text_snippet', color: 'text-gray-500' };
  }
};

interface LessonMaterialsProps {
  lessonId: number;
  files: LessonFile[];
  isAdmin: boolean;
  locked: boolean;          // student has not reached this lesson's phase
  onChanged: () => void;
}

// "Materials" section of the lesson modal: list, view (PDF/TXT/MD), download; admins upload,
// rename and delete.
export const LessonMaterials: React.FC<LessonMaterialsProps> = ({ lessonId, files, isAdmin, locked, onChanged }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<LessonFile | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const upload = async (list: FileList | File[]) => {
    const chosen = Array.from(list);
    if (chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      chosen.forEach((f) => form.append('files', f));
      const res = await fetch(apiUrl(`/lessons/${lessonId}/files`), { method: 'POST', credentials: 'include', body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error || 'Upload failed.'); return; }
      onChanged();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (file: LessonFile) => {
    if (!window.confirm(`Delete "${file.name}" from this lesson?`)) return;
    const res = await fetch(apiUrl(`/lesson-files/${file.id}`), { method: 'DELETE', credentials: 'include' });
    if (res.ok) onChanged(); else setError('Could not delete the file.');
  };

  const rename = async (file: LessonFile) => {
    const name = window.prompt('File name', file.name);
    if (!name || name.trim() === file.name) return;
    const res = await fetch(apiUrl(`/lesson-files/${file.id}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name: name.trim() }),
    });
    if (res.ok) onChanged(); else setError('Could not rename the file.');
  };

  if (!isAdmin && files.length === 0) return null;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-6 mt-6">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-bold text-gray-500">
          MATERIALS ({files.length})
          {!isAdmin && locked && <span className="ml-2 font-semibold normal-case text-gray-400">· they open when you reach this lesson</span>}
        </h4>
        {isAdmin && (
          <>
            <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />
            <button onClick={() => inputRef.current?.click()} disabled={busy}
              className="px-3 py-1.5 rounded-lg text-sm font-bold bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300 flex items-center gap-1 disabled:opacity-50">
              <span className="material-icons text-base">{busy ? 'hourglass_top' : 'attach_file'}</span>{busy ? 'Uploading…' : 'Attach files'}
            </button>
          </>
        )}
      </div>

      {error && <div className="mb-3 p-2 rounded-lg bg-red-50 text-red-700 text-sm font-semibold dark:bg-red-900/30 dark:text-red-300">{error}</div>}

      {isAdmin && files.length === 0 && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          className={`rounded-xl border-2 border-dashed p-6 text-center text-sm cursor-pointer transition-colors ${dragOver ? 'border-primary bg-primary/10' : 'border-gray-300 dark:border-gray-600 text-gray-400 hover:border-primary'}`}>
          <span className="material-icons text-3xl block mb-1">upload_file</span>
          Drop files here or click to attach — PDF, Word, PowerPoint, TXT, Markdown
        </div>
      )}

      <div
        className="space-y-2"
        onDragOver={isAdmin && files.length > 0 ? (e) => { e.preventDefault(); setDragOver(true); } : undefined}
        onDragLeave={isAdmin ? () => setDragOver(false) : undefined}
        onDrop={isAdmin && files.length > 0 ? (e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files); } : undefined}
      >
        {files.map((file) => {
          const st = fileStyle(file.ext);
          const disabled = locked && !isAdmin;
          return (
            <div key={file.id} className={`flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-700 ${disabled ? 'opacity-60' : ''} ${dragOver ? 'ring-2 ring-primary/40' : ''}`}>
              <span className={`material-icons ${st.color}`}>{st.icon}</span>
              <button type="button" disabled={disabled || !file.viewable} onClick={() => setViewing(file)}
                className={`flex-1 min-w-0 text-left ${file.viewable && !disabled ? 'hover:underline cursor-pointer' : 'cursor-default'}`}>
                <div className="font-bold text-gray-800 dark:text-gray-200 truncate">{file.name}</div>
                <div className="text-xs text-gray-400">{file.ext.toUpperCase()} · {formatSize(file.size)}</div>
              </button>
              {!disabled && file.viewable && (
                <button onClick={() => setViewing(file)} className="px-3 py-1.5 rounded-lg text-sm font-bold bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 hover:border-primary flex items-center gap-1">
                  <span className="material-icons text-base">visibility</span>View
                </button>
              )}
              {!disabled && (
                <a href={apiUrl(`/lesson-files/${file.id}/download`)} className="px-3 py-1.5 rounded-lg text-sm font-bold bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 hover:border-primary flex items-center gap-1">
                  <span className="material-icons text-base">download</span>Download
                </a>
              )}
              {disabled && <span className="material-icons text-gray-400">lock</span>}
              {isAdmin && (
                <>
                  <button onClick={() => rename(file)} title="Rename" className="material-icons text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">edit</button>
                  <button onClick={() => remove(file)} title="Delete" className="material-icons text-gray-400 hover:text-red-500">delete_outline</button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <FileViewer file={viewing} onClose={() => setViewing(null)} />
    </div>
  );
};

// Full-screen viewer: the browser's PDF viewer for PDFs; TXT as preformatted text; Markdown
// rendered by react-markdown (no raw HTML).
export const FileViewer: React.FC<{ file: LessonFile | null; onClose: () => void }> = ({ file, onClose }) => {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    if (!file || file.view_as === 'pdf' || !file.viewable) return;
    let cancelled = false;
    fetch(apiUrl(`/lesson-files/${file.id}/view`), { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Could not open the file.');
        return res.text();
      })
      .then((t) => { if (!cancelled) setText(t); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [file]);

  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, onClose]);

  if (!file) return null;
  const st = fileStyle(file.ext);
  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[1100px] max-w-[96vw] h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3">
          <span className={`material-icons ${st.color}`}>{st.icon}</span>
          <h3 className="flex-1 min-w-0 font-bold text-gray-800 dark:text-white truncate">{file.name}</h3>
          <a href={apiUrl(`/lesson-files/${file.id}/download`)} className="px-3 py-1.5 rounded-lg text-sm font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-1">
            <span className="material-icons text-base">download</span>Download
          </a>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"><span className="material-icons">close</span></button>
        </div>
        <div className="flex-1 min-h-0 bg-gray-50 dark:bg-gray-900">
          {file.view_as === 'pdf' ? (
            <iframe title={file.name} src={apiUrl(`/lesson-files/${file.id}/view`)} className="w-full h-full border-0 bg-white" />
          ) : error ? (
            <div className="p-8 text-center text-red-600 font-semibold">{error}</div>
          ) : text === null ? (
            <div className="p-12 flex justify-center"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary" /></div>
          ) : file.view_as === 'markdown' ? (
            <div className="h-full overflow-y-auto custom-scrollbar">
              <div className="max-w-3xl mx-auto p-8 prose dark:prose-invert prose-pre:bg-gray-900 prose-pre:text-gray-100">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <pre className="h-full overflow-auto custom-scrollbar p-6 text-sm font-mono whitespace-pre-wrap break-words text-gray-800 dark:text-gray-200">{text}</pre>
          )}
        </div>
      </div>
    </div>
  );
};
