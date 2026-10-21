import React, { useState } from 'react';
import { CellOutput } from './types';

const COLLAPSE_LINES = 20;

const LIMITS_HELP = 'Each run gets 15 seconds, 384 MB of memory and no network. A teacher can raise nothing here: keep loops bounded and data small.';

const seconds = (ms: number) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);

// Plain sentences for the ways a run can stop
const stoppedText: Record<string, string> = {
  timeout: 'Stopped after 15 s. An infinite loop, or waiting for input that never comes?',
  oom: 'Stopped: the code used more than 384 MB of memory.',
  crashed: 'The Java process stopped before the cell finished (System.exit, or a crash).',
};

const Collapsible: React.FC<{ text: string; className: string }> = ({ text, className }) => {
  const lines = text.split('\n');
  const long = lines.length > COLLAPSE_LINES + 2;
  const [open, setOpen] = useState(!long);
  const shown = open ? text : lines.slice(0, COLLAPSE_LINES).join('\n');
  return (
    <div>
      <pre className={`lp-output-text ${className}`}>{shown}</pre>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="text-xs font-semibold text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 mt-1">
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
};

export const CellOutputView: React.FC<{ output: CellOutput; flash?: boolean; onClear?: () => void }> = ({ output, flash, onClear }) => {
  if (output.status === 'not_run') {
    return <div className="lp-output text-sm italic text-gray-400 px-4 py-2">Not run: an earlier cell failed.</div>;
  }
  const err = output.error;
  return (
    <div className={`lp-output group/out relative px-4 py-2 ${flash ? 'lp-flash' : ''}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          {output.stdout && <Collapsible text={output.stdout.replace(/\n$/, '')} className="text-gray-800 dark:text-gray-100" />}
          {output.stderr && <Collapsible text={output.stderr.replace(/\n$/, '')} className="text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 rounded px-2" />}
          {output.status === 'ok' && output.value !== null && output.value !== undefined && (
            <div className="flex gap-2 items-baseline">
              <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400 select-none">Out</span>
              <Collapsible text={output.value} className="text-gray-900 dark:text-gray-100 font-semibold" />
            </div>
          )}
          {output.status === 'error' && err && (
            <div className="rounded-lg border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/30 px-3 py-2">
              <div className="text-xs font-bold uppercase tracking-wider text-rose-700 dark:text-rose-300 mb-1">
                {err.kind === 'compile' ? 'Does not compile' : (err.exception ? err.exception.split('.').pop() : 'Error')}
                {err.line ? <span className="font-semibold normal-case tracking-normal"> · line {err.line}</span> : null}
              </div>
              <Collapsible text={err.message} className="text-rose-900 dark:text-rose-300" />
            </div>
          )}
          {['timeout', 'oom', 'crashed'].includes(output.status) && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-300">
              {stoppedText[output.status]}{' '}
              <span className="underline decoration-dotted cursor-help" title={LIMITS_HELP}>What are the limits?</span>
            </div>
          )}
          {output.status === 'ok' && !output.stdout && !output.stderr && (output.value === null || output.value === undefined) && (
            <div className="text-xs text-gray-400 italic">Ran without output.</div>
          )}
          {output.truncated && <div className="text-xs text-amber-700 dark:text-amber-300">Output was cut at 64 KB.</div>}
        </div>
        <div className="shrink-0 flex items-center gap-2 text-[11px] text-gray-400 tabular-nums pt-0.5">
          <span>{seconds(output.durationMs)}</span>
          {onClear && (
            <button type="button" onClick={onClear} title="Clear output" className="opacity-0 group-hover/out:opacity-100 focus:opacity-100 hover:text-gray-700 dark:hover:text-gray-200 transition-opacity">
              <span aria-hidden="true" className="material-icons text-base leading-none">clear</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
