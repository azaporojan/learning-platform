import React from 'react';
import { CheckResult, CheckStatus } from './types';

const tone: Record<CheckStatus, string> = {
  running: 'border-sky-200 bg-sky-50 text-sky-900',
  passed: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  failed: 'border-rose-200 bg-rose-50 text-rose-900',
  compile_error: 'border-rose-200 bg-rose-50 text-rose-900',
  no_tests: 'border-gray-200 bg-gray-50 text-gray-800',
  timeout: 'border-amber-200 bg-amber-50 text-amber-900',
  oom: 'border-amber-200 bg-amber-50 text-amber-900',
  crashed: 'border-amber-200 bg-amber-50 text-amber-900',
  error: 'border-gray-200 bg-gray-50 text-gray-800',
  unavailable: 'border-gray-200 bg-gray-50 text-gray-800',
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
          <li key={i} className="rounded-lg bg-white/70 border border-rose-100 px-3 py-2">
            <div className="font-mono text-xs font-bold text-rose-800">{f.name}</div>
            <pre className="lp-output-text text-rose-900 mt-1">{f.message}</pre>
          </li>
        ))}
      </ul>
    )}
    {!compact && result.diagnostics && result.diagnostics.length > 0 && (
      <ul className="mt-2 space-y-2">
        {result.diagnostics.map((d, i) => (
          <li key={i} className="rounded-lg bg-white/70 border border-rose-100 px-3 py-2">
            <div className="font-mono text-xs font-bold text-rose-800">{d.file || 'compiler'}{d.line ? `:${d.line}` : ''}</div>
            <pre className="lp-output-text text-rose-900 mt-1">{d.message}</pre>
          </li>
        ))}
      </ul>
    )}
    {!compact && result.stdout && (
      <details className="mt-2">
        <summary className="text-xs font-bold cursor-pointer">Output printed while the tests ran (teachers only)</summary>
        <pre className="lp-output-text mt-1 max-h-60 overflow-y-auto bg-white/70 rounded p-2">{result.stdout}</pre>
      </details>
    )}
  </div>
);

// Small chip for submission lists
export const CheckChip: React.FC<{ status?: string | null; passed?: number | null; total?: number | null; onClick?: () => void }> = ({ status, passed, total, onClick }) => {
  if (!status) return null;
  const s = status as CheckStatus;
  const label = s === 'running' ? 'Checking…' : total ? `${passed ?? 0}/${total} tests` : ({ compile_error: 'Does not compile', timeout: 'Timed out', oom: 'Out of memory', crashed: 'Crashed', unavailable: 'Not checked', error: 'Check failed', no_tests: 'No tests' } as Record<string, string>)[s] || s;
  const color = s === 'passed' ? 'bg-emerald-100 text-emerald-800' : s === 'running' ? 'bg-sky-100 text-sky-800' : ['failed', 'compile_error'].includes(s) ? 'bg-rose-100 text-rose-800' : 'bg-gray-100 text-gray-700';
  return (
    <button type="button" onClick={onClick} disabled={!onClick} title="See the check" className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${color} ${onClick ? 'hover:ring-2 ring-offset-1 ring-current/30' : ''}`}>
      <span aria-hidden="true" className="material-icons text-[14px]">{icon[s] || 'science'}</span>{label}
    </button>
  );
};
