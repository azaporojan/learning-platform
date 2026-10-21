import React from 'react';
import { CheckResult, CheckStatus } from './types';

const tone: Record<CheckStatus, string> = {
  running: 'border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-900/30 text-sky-900 dark:text-sky-300',
  passed: 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-900 dark:text-emerald-300',
  failed: 'border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/30 text-rose-900 dark:text-rose-300',
  compile_error: 'border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/30 text-rose-900 dark:text-rose-300',
  no_tests: 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100',
  timeout: 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-300',
  oom: 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-300',
  crashed: 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-300',
  error: 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100',
  unavailable: 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100',
};

const icon: Record<CheckStatus, string> = {
  running: 'hourglass_top', passed: 'task_alt', failed: 'cancel', compile_error: 'code_off', no_tests: 'help_outline',
  timeout: 'timer_off', oom: 'memory', crashed: 'report', error: 'error_outline', unavailable: 'cloud_off',
};

// The verdict of a check: summary, failing tests with their messages, compile errors
export const CheckResultView: React.FC<{ result: CheckResult; compact?: boolean }> = ({ result, compact }) => (
  <div className={`rounded-xl border px-4 py-3 ${tone[result.status] || tone.error}`}>
    <div className="flex items-center gap-2 font-bold">
      <span aria-hidden="true" className={`material-icons text-[20px] ${result.status === 'running' ? 'animate-pulse' : ''}`}>{icon[result.status] || 'help_outline'}</span>
      <span>{result.summary}</span>
      {result.tests && result.tests.total > 0 && (
        <span className="ml-auto text-sm font-semibold tabular-nums">{result.tests.passed} / {result.tests.total}</span>
      )}
    </div>
    {!compact && result.tests && result.tests.failed.length > 0 && (
      <ul className="mt-2 space-y-2">
        {result.tests.failed.map((f, i) => (
          <li key={i} className="rounded-lg bg-white/70 dark:bg-gray-900/70 border border-rose-100 dark:border-rose-800 px-3 py-2">
            <div className="font-mono text-xs font-bold text-rose-800 dark:text-rose-300">{f.name}</div>
            <pre className="lp-output-text text-rose-900 dark:text-rose-300 mt-1">{f.message}</pre>
          </li>
        ))}
      </ul>
    )}
    {!compact && result.diagnostics && result.diagnostics.length > 0 && (
      <ul className="mt-2 space-y-2">
        {result.diagnostics.map((d, i) => (
          <li key={i} className="rounded-lg bg-white/70 dark:bg-gray-900/70 border border-rose-100 dark:border-rose-800 px-3 py-2">
            <div className="font-mono text-xs font-bold text-rose-800 dark:text-rose-300">{d.file || 'compiler'}{d.line ? `:${d.line}` : ''}</div>
            <pre className="lp-output-text text-rose-900 dark:text-rose-300 mt-1">{d.message}</pre>
          </li>
        ))}
      </ul>
    )}
    {!compact && result.stdout && (
      <details className="mt-2">
        <summary className="text-xs font-bold cursor-pointer">Output printed while the tests ran (teachers only)</summary>
        <pre className="lp-output-text mt-1 max-h-60 overflow-y-auto bg-white/70 dark:bg-gray-900/70 rounded p-2">{result.stdout}</pre>
      </details>
    )}
  </div>
);

// Small chip for submission lists
export const CheckChip: React.FC<{ status?: string | null; passed?: number | null; total?: number | null; onClick?: () => void }> = ({ status, passed, total, onClick }) => {
  if (!status) return null;
  const s = status as CheckStatus;
  const label = s === 'running' ? 'Checking…' : total ? `${passed ?? 0}/${total} tests` : ({ compile_error: 'Does not compile', timeout: 'Timed out', oom: 'Out of memory', crashed: 'Crashed', unavailable: 'Not checked', error: 'Check failed', no_tests: 'No tests' } as Record<string, string>)[s] || s;
  const color = s === 'passed' ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300' : s === 'running' ? 'bg-sky-100 dark:bg-sky-900/40 text-sky-800 dark:text-sky-300' : ['failed', 'compile_error'].includes(s) ? 'bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200';
  return (
    <button type="button" onClick={onClick} disabled={!onClick} title="See the check" className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${color} ${onClick ? 'hover:ring-2 ring-offset-1 ring-current/30' : ''}`}>
      <span aria-hidden="true" className="material-icons text-[14px]">{icon[s] || 'science'}</span>{label}
    </button>
  );
};
