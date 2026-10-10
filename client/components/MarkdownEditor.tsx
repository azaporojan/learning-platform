import React, { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import TurndownService from 'turndown';
import { apiUrl, getFileUrl } from '../config';

// Older task descriptions were saved as HTML by the previous rich-text editor. They always start
// with a block tag; Markdown that merely mentions a tag (`List<String>`) does not.
export const isLegacyHtml = (value: string) => /^\s*<(p|h[1-6]|ul|ol|li|img|blockquote|pre|div|hr|br|strong|em|a)[\s>/]/i.test(value);

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });

// Text for the Markdown editor: legacy HTML is converted once, Markdown is kept as is.
export const toMarkdown = (value: string) => (isLegacyHtml(value) ? turndown.turndown(value) : value);

const PROSE = 'prose dark:prose-invert max-w-none prose-th:bg-gray-100 dark:prose-th:bg-gray-800 prose-th:px-3 prose-td:px-3 prose-pre:bg-gray-900';

// Uploaded images are served under the API prefix; older descriptions stored the bare /uploads/… path.
const fileSrc = (src?: string) => (src && src.startsWith('/uploads/') ? getFileUrl(src) || src : src);
const markdownComponents = {
  img: ({ node, src, alt, ...props }: any) => src
    ? <img src={fileSrc(src)} alt={alt} loading="lazy" {...props} />
    : <span className="inline-block text-sm text-gray-400 italic">{alt}</span>, // e.g. a screenshot still uploading
  a: ({ node, ...props }: any) => <a target="_blank" rel="noopener noreferrer" {...props} />,
};

// Read-only rendering of a description: Markdown (no raw HTML), or legacy HTML as it was saved.
export const MarkdownContent: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) =>
  isLegacyHtml(text)
    ? <div className={`${PROSE} ${className}`} dangerouslySetInnerHTML={{ __html: text.replace(/(src=["'])\/uploads\//g, `$1${getFileUrl('/uploads/')}`) }} />
    : <div className={`${PROSE} ${className}`}><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{text}</ReactMarkdown></div>;

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onError?: (message: string) => void;
  placeholder?: string;
}

const uploadImage = async (file: File): Promise<string> => {
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetch(apiUrl('/upload-image'), { method: 'POST', credentials: 'include', body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || 'Failed to upload image');
  return data.url; // stored relative (/uploads/…); fileSrc resolves it against the API at render time
};

// Markdown source next to a live preview (same format as the lesson script). Screenshots can be
// pasted or dropped straight into the text: they are uploaded and embedded as ![](url).
export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({ value, onChange, onError, placeholder }) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Latest text, so an upload finishing later edits what is there now, not what was there then
  const valueRef = useRef(value);
  valueRef.current = value;
  const [uploads, setUploads] = useState(0);

  const setText = (text: string, selStart?: number, selEnd?: number) => {
    valueRef.current = text;
    onChange(text);
    if (selStart !== undefined) {
      requestAnimationFrame(() => {
        const ta = ref.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(selStart, selEnd ?? selStart);
      });
    }
  };

  // Wrap the selection (or a placeholder word) in inline markers such as ** or *
  const wrap = (before: string, after = before, fallback = 'text') => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const v = valueRef.current;
    const inner = v.slice(s, e) || fallback;
    setText(v.slice(0, s) + before + inner + after + v.slice(e), s + before.length, s + before.length + inner.length);
  };

  // Prefix every line touched by the selection, e.g. "## ", "- ", "1. "
  const prefixLines = (prefix: (i: number) => string) => {
    const ta = ref.current;
    if (!ta) return;
    const v = valueRef.current;
    const start = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = v.indexOf('\n', ta.selectionEnd);
    if (end === -1) end = v.length;
    const block = v.slice(start, end).split('\n').map((line, i) => prefix(i) + line).join('\n');
    setText(v.slice(0, start) + block + v.slice(end), start + block.length);
  };

  const insertImages = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length || !ref.current) return;
    const ta = ref.current;
    const v = valueRef.current;
    const s = ta.selectionStart;
    const tokens = images.map((f, i) => `![Uploading ${(f.name || 'image').replace(/[[\]]/g, '')} #${Date.now()}-${i}…]()`);
    const before = v.slice(0, s);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    const inserted = lead + tokens.join('\n') + '\n';
    setText(before + inserted + v.slice(ta.selectionEnd), s + inserted.length);
    setUploads((n) => n + images.length);
    await Promise.all(images.map(async (file, i) => {
      let replacement = '';
      try {
        const url = await uploadImage(file);
        const alt = (file.name && file.name !== 'image.png' ? file.name.replace(/\.[^.]+$/, '') : 'screenshot').replace(/[[\]]/g, '');
        replacement = `![${alt}](${url})`;
      } catch (err: any) {
        onError?.(err?.message || 'Failed to upload image');
      } finally {
        setUploads((n) => n - 1);
      }
      const current = valueRef.current;
      const token = replacement ? tokens[i] : tokens[i] + '\n';
      if (!current.includes(token)) {
        // The placeholder was edited away while uploading: say so rather than drop the image silently
        if (replacement) onError?.(`The image was uploaded but its placeholder was removed, so it was not inserted: ${replacement}`);
        return;
      }
      // Function replacer: a file name containing $& or $1 must be inserted literally
      setText(current.replace(token, () => replacement));
    }));
  };

  const pickImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif';
    input.multiple = true;
    input.onchange = () => insertImages(Array.from(input.files || []));
    input.click();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files || []);
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      insertImages(files);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer.files || []);
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      // Drop where the pointer is when the browser reports a text offset inside the textarea
      // (caretPositionFromPoint); otherwise at the cursor. caretRangeFromPoint is not used: its
      // offset is a DOM-node index, not a character position in a textarea.
      const caret = (document as any).caretPositionFromPoint?.(e.clientX, e.clientY);
      if (caret && caret.offsetNode === ref.current && typeof caret.offset === 'number') ref.current!.setSelectionRange(caret.offset, caret.offset);
      insertImages(files);
    }
  };

  const btn = 'px-3 py-1 rounded bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm';

  return (
    <div className="rounded-xl overflow-hidden border border-gray-200 dark:border-gray-600">
      <div className="bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-2 flex flex-wrap items-center gap-1">
        <button type="button" className={btn} title="Bold" onClick={() => wrap('**')}><strong>B</strong></button>
        <button type="button" className={btn} title="Italic" onClick={() => wrap('*')}><em>I</em></button>
        <button type="button" className={btn} title="Heading" onClick={() => prefixLines(() => '## ')}>H2</button>
        <button type="button" className={btn} title="Bullet list" onClick={() => prefixLines(() => '- ')}>• List</button>
        <button type="button" className={btn} title="Numbered list" onClick={() => prefixLines((i) => `${i + 1}. `)}>1. List</button>
        <button type="button" className={`${btn} font-mono`} title="Inline code" onClick={() => wrap('`', '`', 'code')}>{'</>'}</button>
        <button type="button" className={btn} title="Code block" onClick={() => wrap('\n```\n', '\n```\n', 'code')}>{'```'}</button>
        <button type="button" className={btn} title="Link" onClick={() => wrap('[', '](https://)', 'link text')}>Link</button>
        <button type="button" onClick={pickImage} className="px-3 py-1 rounded bg-green-500 hover:bg-green-600 text-white flex items-center gap-1 text-sm">
          <span className="material-icons text-sm">image</span>Image
        </button>
        <span className="ml-auto text-xs text-gray-500 dark:text-gray-400 pr-1">
          {uploads > 0 ? `Uploading ${uploads} image${uploads > 1 ? 's' : ''}…` : 'Markdown · paste or drop screenshots'}
        </span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onDrop={onDrop}
          spellCheck={false}
          placeholder={placeholder}
          className="min-h-[360px] w-full resize-y p-4 font-mono text-sm leading-relaxed bg-gray-50 dark:bg-gray-950 text-gray-800 dark:text-gray-100 outline-none border-b lg:border-b-0 lg:border-r border-gray-200 dark:border-gray-700"
        />
        <div className="p-4 max-h-[60vh] overflow-y-auto bg-white dark:bg-gray-800">
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Preview</div>
          {value.trim()
            ? <MarkdownContent text={value} />
            : <p className="text-gray-400 italic text-sm">Nothing to preview yet.</p>}
        </div>
      </div>
    </div>
  );
};
