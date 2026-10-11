import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// A ```tests fenced block holds a Markdown table of test cases. It renders collapsed, and the
// "Expected" column is masked until the student clicks a cell (or "Reveal all" for the block):
//
//   ```tests FizzBuzz
//   | # | Input | Expected |
//   |---|-------|----------|
//   | 1 | `3`   | `"Fizz"` |
//   ```
//
// The text after `tests` is the block's title. The masked column is the first header starting
// with "Expected" (or Ожидаемый / Așteptat); without one, the last column.

const EXPECTED_HEADER = /^\s*(expected|ожидаем|aștept|astept)/i;

// Cells of a table row, split on unescaped pipes (GFM allows `\|` inside a cell)
const splitRow = (line: string) => {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
};

export const parseTestTable = (source: string) => {
  const lines = source.split('\n').filter((line) => line.trim());
  const headers = lines.length ? splitRow(lines[0]) : [];
  const found = headers.findIndex((h) => EXPECTED_HEADER.test(h.replace(/[*_`]/g, '')));
  const rows = lines.filter((line, i) => i > 0 && !/^\s*\|?\s*:?-{1,}/.test(line)).length;
  return { expectedIndex: found >= 0 ? found : headers.length - 1, rows };
};

// Bumping `version` re-applies `all` to every cell, so "Reveal all" / "Hide all" win over
// cells toggled one by one before it.
const RevealContext = createContext({ all: false, version: 0 });

const SpoilerCell: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const { all, version } = useContext(RevealContext);
  const [open, setOpen] = useState(all);
  useEffect(() => setOpen(all), [all, version]);
  return (
    <td className="align-top">
      {open ? (
        <button type="button" onClick={() => setOpen(false)} title="Click to hide" className="text-left cursor-pointer">
          {children}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Click to reveal the expected result"
          aria-label="Hidden expected result, click to reveal"
          className="px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 font-mono tracking-widest hover:bg-gray-300 dark:hover:bg-gray-600"
        >
          *****
        </button>
      )}
    </td>
  );
};

const tableComponents = (expectedIndex: number) => ({
  // Mark the expected cell of each body row; header cells (th) are left as they are
  tr: ({ node, children, ...props }: any) => {
    let col = -1;
    const cells = React.Children.map(children, (child) => {
      if (!React.isValidElement(child)) return child;
      col += 1;
      return col === expectedIndex && child.type === 'td'
        ? <SpoilerCell>{(child.props as any).children}</SpoilerCell>
        : child;
    });
    return <tr {...props}>{cells}</tr>;
  },
});

export const TestCasesBlock: React.FC<{ source: string; title?: string }> = ({ source, title }) => {
  const [expanded, setExpanded] = useState(false);
  const [reveal, setReveal] = useState({ all: false, version: 0 });
  const { expectedIndex, rows } = parseTestTable(source);
  // Stable renderers: a new `tr` type on every render would remount the cells and hide them again
  const components = useMemo(() => tableComponents(expectedIndex), [expectedIndex]);
  const toggleAll = () => setReveal((r) => ({ all: !r.all, version: r.version + 1 }));

  return (
    <div className="not-prose my-4 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex items-center gap-1 font-semibold text-sm text-gray-800 dark:text-gray-100 flex-1 text-left"
        >
          <span className="material-icons text-base">{expanded ? 'expand_more' : 'chevron_right'}</span>
          {title || 'Test cases'}
          <span className="font-normal text-gray-500 dark:text-gray-400">({rows})</span>
        </button>
        {expanded && (
          <button
            type="button"
            onClick={toggleAll}
            className="px-2 py-1 rounded text-xs bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600"
          >
            {reveal.all ? 'Hide all' : 'Reveal all'}
          </button>
        )}
      </div>
      {expanded && (
        <RevealContext.Provider value={reveal}>
          <div className="prose dark:prose-invert max-w-none prose-th:bg-gray-100 dark:prose-th:bg-gray-800 prose-th:px-3 prose-td:px-3 px-3 overflow-x-auto">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{source}</ReactMarkdown>
          </div>
        </RevealContext.Provider>
      )}
    </div>
  );
};

// `pre` renderer for react-markdown: a ```tests block becomes a TestCasesBlock, any other code
// block renders as usual.
export const PreWithTestCases = ({ node, children, ...props }: any) => {
  const code = node?.children?.[0];
  const classes: string[] = code?.properties?.className || [];
  if (code?.tagName === 'code' && classes.includes('language-tests')) {
    const source = (code.children || []).map((c: any) => c.value || '').join('');
    const title = typeof code.data?.meta === 'string' ? code.data.meta.trim() : '';
    return <TestCasesBlock source={source} title={title || undefined} />;
  }
  return <pre {...props}>{children}</pre>;
};
