// Auto-checked tasks (server/taskChecks.js)
export interface CodeFile { path: string; content: string }

export type CheckStatus = 'running' | 'passed' | 'failed' | 'compile_error' | 'no_tests' | 'timeout' | 'oom' | 'crashed' | 'error' | 'unavailable';

export interface CheckResult {
  status: CheckStatus;
  summary: string;
  diagnostics: { file: string | null; line: number | null; message: string }[] | null;
  tests: { total: number; passed: number; failed: { name: string; message: string }[] } | null;
  durationMs?: number;
  only?: string; // the class a try was limited to
  stdout?: string; // admins only
}

export interface TaskCheckConfig {
  enabled: boolean;
  tests?: CodeFile[]; // admins only
  starter?: CodeFile[];
  timeout_s?: number;
  auto_approve?: boolean;
  test_files?: number;
  configured?: boolean;
  runner_configured?: boolean;
}

export interface SubmissionCheck {
  id: number;
  submission_id: number;
  status: CheckStatus;
  summary: string;
  passed: number | null;
  total: number | null;
  files: CodeFile[];
  result: CheckResult | null;
  created_at: string;
  finished_at: string | null;
}
