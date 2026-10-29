// Present mode scratch edits: the teacher may expand an example on the spot. The edits live only
// in memory for the duration of the presentation and are never saved to the notebook.
import type { Cell, CellOutput } from './types';

export type Drafts = Record<string, string>; // cell id -> edited source

// The cells as they would run now: a drafted cell takes its edited source, the rest stay as saved
export function applyDrafts(cells: Cell[], drafts: Drafts): Cell[] {
  return cells.map((c) => (c.id in drafts && drafts[c.id] !== c.source ? { ...c, source: drafts[c.id] } : c));
}

// Records an edit; typing the saved text back drops the draft so the cell no longer counts as edited
export function withDraft(drafts: Drafts, cell: Cell, source: string): Drafts {
  if (source === cell.source) {
    if (!(cell.id in drafts)) return drafts;
    const next = { ...drafts };
    delete next[cell.id];
    return next;
  }
  return { ...drafts, [cell.id]: source };
}

export function isDrafted(drafts: Drafts, cell: Cell): boolean {
  return cell.id in drafts && drafts[cell.id] !== cell.source;
}

// Outputs of scratch runs, kept beside the drafts. Resetting a cell makes its own scratch output
// and those of every cell after it stale (they may have run on top of the edit), so they go;
// the cells before it keep theirs.
export function dropScratchFrom(outputs: Record<string, CellOutput>, cells: Cell[], cellId: string): Record<string, CellOutput> {
  const at = cells.findIndex((c) => c.id === cellId);
  if (at === -1) return outputs;
  const stale = new Set(cells.slice(at).map((c) => c.id));
  const next: Record<string, CellOutput> = {};
  for (const [id, out] of Object.entries(outputs)) if (!stale.has(id)) next[id] = out;
  return next;
}
