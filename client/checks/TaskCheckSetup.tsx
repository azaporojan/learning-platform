import React, { useEffect, useState } from 'react';
import { api } from '../notebooks/api';
import { Modal } from '../notebooks/Modal';
import { CodeFile, CheckResult, TaskCheckConfig } from './types';
import { CheckResultView } from './CheckResult';
import { FileTabsEditor } from './FileTabsEditor';

const TEST_TEMPLATE: CodeFile = {
  path: 'shop/CalculatorTest.java',
  content: `package shop;

import org.junit.jupiter.api.*;
import static org.assertj.core.api.Assertions.assertThat;

class CalculatorTest {
    private final Calculator calc = new Calculator();

    @Test
    @DisplayName("adds two numbers")
    void adds() {
        assertThat(calc.add(2, 3)).isEqualTo(5);
    }
}
`,
};
const STARTER_TEMPLATE: CodeFile = { path: 'shop/Calculator.java', content: 'package shop;\n\npublic class Calculator {\n    // TODO: add(int a, int b)\n}\n' };

// Teacher side: hidden tests, starter files, limits, auto-approve, and a way to try the tests
// against a reference solution before students see them.
const TaskCheckSetup: React.FC<{ taskId: number }> = ({ taskId }) => {
  const [config, setConfig] = useState<TaskCheckConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [tests, setTests] = useState<CodeFile[]>([]);
  const [starter, setStarter] = useState<CodeFile[]>([]);
  const [solution, setSolution] = useState<CodeFile[]>([]);
  const [timeoutS, setTimeoutS] = useState(30);
  const [autoApprove, setAutoApprove] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [tab, setTab] = useState<'tests' | 'starter' | 'solution'>('tests');
  const [result, setResult] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api<TaskCheckConfig>(`/tasks/${taskId}/check`).then(setConfig).catch(() => setConfig({ enabled: false, configured: false }));
  useEffect(() => { load(); }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = () => {
    const c = config || { enabled: false };
    const t = c.tests && c.tests.length ? c.tests : [TEST_TEMPLATE];
    const st = c.starter && c.starter.length ? c.starter : [STARTER_TEMPLATE];
    setTests(t); setStarter(st); setSolution(st.map((f) => ({ ...f })));
    setTimeoutS(c.timeout_s || 30); setAutoApprove(Boolean(c.auto_approve)); setEnabled(c.configured === false ? true : c.enabled);
    setResult(null); setError(null); setTab('tests'); setOpen(true);
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api(`/tasks/${taskId}/check`, { method: 'PUT', json: { tests, starter, timeoutS, autoApprove, enabled } });
      await load();
      return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };

  const tryTests = async () => {
    if (!(await save())) return;
    setBusy(true); setResult({ status: 'running', summary: 'Running the tests against your solution…', diagnostics: null, tests: null });
    try { setResult(await api<CheckResult>(`/tasks/${taskId}/check/try`, { json: { files: solution } })); }
    catch (e) { setResult(null); setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    try { await api(`/tasks/${taskId}/check`, { method: 'DELETE' }); await load(); setOpen(false); } catch (e) { setError((e as Error).message); }
  };

  const configured = config && config.configured !== false && (config.tests || []).length > 0;
  return (
    <div className="border-t border-gray-200 pt-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-sm font-bold text-gray-500 flex items-center gap-1"><span aria-hidden="true" className="material-icons text-base">science</span>AUTO-CHECK</span>
          <p className="text-sm text-gray-600 mt-1">
            {!config ? 'Loading…' : configured
              ? `${config.enabled ? 'On' : 'Off'} · ${(config.tests || []).length} hidden test file${(config.tests || []).length === 1 ? '' : 's'} · ${config.timeout_s} s · ${config.auto_approve ? 'passing code is approved automatically' : 'you approve'}`
              : 'Students submit Java files and hidden JUnit tests check them.'}
          </p>
          {config && config.runner_configured === false && <p className="text-xs text-amber-700 mt-1">The code runner is not set up on this server yet.</p>}
        </div>
        <button type="button" onClick={begin} className="shrink-0 px-4 py-2 rounded-lg border-2 border-gray-200 font-bold text-gray-700 hover:border-primary-dark">{configured ? 'Edit' : 'Set up'}</button>
      </div>

      {open && (
        <Modal title="Auto-check" onClose={() => setOpen(false)} wide>
          <div className="space-y-4">
            <div className="flex rounded-xl bg-gray-100 p-1 w-fit" role="tablist">
              {([['tests', 'Hidden tests'], ['starter', 'Starter code'], ['solution', 'Try with a solution']] as const).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-lg text-sm font-bold ${tab === k ? 'bg-white shadow-sm' : 'text-gray-500'}`}>{label}</button>
              ))}
            </div>
            {tab === 'tests' && (
              <>
                <p className="text-xs text-gray-500">JUnit 5 with AssertJ. Students never see these files; failing test names and assertion messages are shown to them, so name tests the way you want them read.</p>
                <FileTabsEditor files={tests} onChange={setTests} allowStructure newFileName="MainTest.java" />
              </>
            )}
            {tab === 'starter' && (
              <>
                <p className="text-xs text-gray-500">What students start from (they can add files). Leave a single empty file for "write it from scratch".</p>
                <FileTabsEditor files={starter} onChange={setStarter} allowStructure newFileName="Main.java" />
              </>
            )}
            {tab === 'solution' && (
              <>
                <p className="text-xs text-gray-500">Paste a reference solution and run the hidden tests against it. Nothing here is saved or shown to students.</p>
                <FileTabsEditor files={solution} onChange={setSolution} allowStructure newFileName="Main.java" />
                <button type="button" onClick={tryTests} disabled={busy} className="px-4 py-2 rounded-lg bg-gray-900 text-white font-bold hover:bg-gray-700 disabled:opacity-50 inline-flex items-center gap-1">
                  <span aria-hidden="true" className="material-icons text-[20px]">play_arrow</span>Save and run the tests
                </button>
                {result && <CheckResultView result={result} />}
              </>
            )}
            <div className="grid sm:grid-cols-3 gap-4 pt-2 border-t border-gray-100">
              <label className="block">
                <span className="text-sm font-bold text-gray-700">Time per check</span>
                <select value={timeoutS} onChange={(e) => setTimeoutS(Number(e.target.value))} className="mt-1 w-full rounded-lg border-gray-300">
                  {[10, 20, 30, 45, 60].map((s) => <option key={s} value={s}>{s} seconds</option>)}
                </select>
              </label>
              <label className="flex items-start gap-2 sm:pt-6">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="mt-1 rounded text-primary-dark" />
                <span className="text-sm"><span className="font-bold text-gray-700">On</span><span className="block text-xs text-gray-500">Students see the code editor</span></span>
              </label>
              <label className="flex items-start gap-2 sm:pt-6">
                <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} className="mt-1 rounded text-primary-dark" />
                <span className="text-sm"><span className="font-bold text-gray-700">Auto-approve</span><span className="block text-xs text-gray-500">Approve when every test passes. Student code runs next to the checker, so a determined student could fake a pass: keep it off for graded work.</span></span>
              </label>
            </div>
            {error && <p className="text-sm text-rose-600">{error}</p>}
            <div className="flex items-center justify-between pt-2">
              {configured ? <button type="button" onClick={remove} className="text-sm font-bold text-rose-600 hover:underline">Remove auto-check</button> : <span />}
              <button type="button" onClick={async () => { if (await save()) setOpen(false); }} disabled={busy} className="px-5 py-2 rounded-full bg-primary font-bold text-gray-900 hover:bg-primary-dark hover:text-white disabled:opacity-50">Save</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default TaskCheckSetup;
