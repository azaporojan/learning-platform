// Notebooks (server/notebooks.js)
export type CellKind = 'code' | 'text';

export interface Cell {
  id: string;
  kind: CellKind;
  source: string;
  input?: string; // code cells: what Scanner / System.in reads when the cell runs
}

export type OutputStatus = 'ok' | 'error' | 'timeout' | 'oom' | 'crashed' | 'not_run';

export interface CellError {
  kind: string; // compile | runtime | timeout | oom | crashed | internal
  message: string;
  line: number | null;
  column?: number | null; // compile errors: the token javac pointed at (1-based), when known
  endLine?: number | null;
  endColumn?: number | null;
  exception?: string;
}

export interface CellOutput {
  status: OutputStatus;
  stdout: string;
  stderr: string;
  value: string | null;
  error: CellError | null;
  truncated: boolean;
  durationMs: number;
  executionCount: number | null;
  ranAt: string;
}

export interface NotebookSummary {
  id: number;
  title: string;
  description: string;
  owner: { id: number; name: string; is_teacher: boolean };
  kind: 'lesson' | 'playground';
  lesson: { id: number; title: string; path_id: number; course_id: number | null; course_name: string | null } | null;
  published: boolean;
  copied_from: { id: number | null; title: string | null; owner_name: string | null; updated_since_copy: boolean; removed: boolean } | null;
  cell_count: number;
  code_cell_count: number;
  copies_count?: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  locked?: boolean;
  my_copy_id?: number | null;
}

export interface Notebook extends NotebookSummary {
  cells: Cell[];
  outputs: Record<string, CellOutput>;
  version: number;
  revision: number;
  can_edit: boolean;
  can_run: boolean;
  runner_configured: boolean;
}
