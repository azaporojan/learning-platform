import React, { useEffect, useId, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightCode, classHighlighter } from '@lezer/highlight';
import { javaLanguage } from '@codemirror/lang-java';
import { notebookFileSrc } from './api';

// Callouts: a blockquote whose first word is bold and one of these becomes a coloured box
//   > **Note** Streams are lazy.
const CALLOUTS: Record<string, { label: string; className: string }> = {
  note: { label: 'Note', className: 'border-sky-400 bg-sky-50 text-sky-950' },
  tip: { label: 'Tip', className: 'border-emerald-400 bg-emerald-50 text-emerald-950' },
  goal: { label: 'Goal', className: 'border-lime-500 bg-lime-50 text-lime-950' },
  warning: { label: 'Warning', className: 'border-amber-400 bg-amber-50 text-amber-950' },
  important: { label: 'Important', className: 'border-rose-400 bg-rose-50 text-rose-950' },
  istqb: { label: 'ISTQB', className: 'border-violet-400 bg-violet-50 text-violet-950' },
  exercise: { label: 'Exercise', className: 'border-indigo-400 bg-indigo-50 text-indigo-950' },
};

const textOf = (node: any): string => (node ? (node.type === 'text' ? node.value : (node.children || []).map(textOf).join('')) : '');

function calloutKind(node: any): string | null {
  const firstP = (node.children || []).find((c: any) => c.type === 'element');
  if (!firstP || firstP.tagName !== 'p') return null;
  const strong = (firstP.children || []).find((c: any) => c.type === 'element' || (c.type === 'text' && c.value.trim()));
  if (!strong || strong.tagName !== 'strong') return null;
  const key = textOf(strong).trim().replace(/[:.]$/, '').toLowerCase();
  return CALLOUTS[key] ? key : null;
}

// Java (and Java-like) code that is shown, not run: highlighted with the same grammar as the editor
export const HighlightedJava: React.FC<{ code: string }> = ({ code }) => {
  const parts: React.ReactNode[] = [];
  let i = 0;
  highlightCode(code, javaLanguage.parser.parse(code), classHighlighter,
    (text, classes) => { parts.push(classes ? <span key={i++} className={classes}>{text}</span> : text); },
    () => { parts.push('\n'); });
  return <>{parts}</>;
};

let mermaidLoader: Promise<any> | null = null;
const loadMermaid = () => {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'Inter, sans-serif' });
      return m.default;
    });
  }
  return mermaidLoader;
};

const Mermaid: React.FC<{ code: string }> = ({ code }) => {
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then((m) => m.render(id, code))
      .then((r: { svg: string }) => { if (!cancelled) { setSvg(r.svg); setError(null); } })
      .catch((e: Error) => { if (!cancelled) setError(e.message || 'Diagram error'); });
    return () => { cancelled = true; };
  }, [code, id]);
  if (error) return <pre className="text-xs text-rose-700 bg-rose-50 rounded-lg p-3 whitespace-pre-wrap">Diagram error: {error}</pre>;
  if (!svg) return <div className="text-sm text-gray-400 py-6 text-center">Drawing diagram…</div>;
  // securityLevel "strict": Mermaid sanitises the SVG (no scripts, no HTML labels)
  return <div className="lp-mermaid flex justify-center my-4 overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
};

const components = {
  img: ({ node, src, alt, ...props }: any) => <img src={notebookFileSrc(src)} alt={alt || ''} loading="lazy" className="rounded-lg max-w-full mx-auto" {...props} />,
  a: ({ node, ...props }: any) => <a target="_blank" rel="noopener noreferrer" {...props} />,
  pre: ({ node, children }: any) => {
    const codeEl = node && node.children && node.children[0];
    const lang = ((codeEl && codeEl.properties && codeEl.properties.className) || []).map(String).find((c: string) => c.startsWith('language-'))?.slice(9) || '';
    const code = textOf(codeEl).replace(/\n$/, '');
    if (lang === 'mermaid') return <Mermaid code={code} />;
    if (['java', 'jshell', 'kotlin', 'groovy'].includes(lang)) {
      return <pre className="lp-code-block"><code><HighlightedJava code={code} /></code></pre>;
    }
    return <pre className="lp-code-block">{children}</pre>;
  },
  blockquote: ({ node, children }: any) => {
    const kind = calloutKind(node);
    if (!kind) return <blockquote>{children}</blockquote>;
    const c = CALLOUTS[kind];
    return <div className={`lp-callout not-prose border-l-4 rounded-r-lg px-4 py-3 my-4 ${c.className}`} data-callout={kind}>{children}</div>;
  },
};

export const NotebookMarkdown: React.FC<{ source: string; className?: string }> = ({ source, className = '' }) => (
  <div className={`prose max-w-none prose-headings:font-extrabold prose-pre:p-0 prose-pre:bg-transparent prose-img:my-4 ${className}`}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{source}</ReactMarkdown>
  </div>
);

// Headings of the text cells, for the outline
export function headingsOf(source: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  let fence = false;
  for (const line of source.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, '') });
  }
  return out;
}
