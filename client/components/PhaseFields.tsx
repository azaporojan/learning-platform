import React from 'react';
import { Course } from '../types';

// Shared form for a phase (path): name, description, course, order and the two gates
// (sequence + stars). Used by AddPathModal and EditPathModal.
export interface PhaseFormState {
  name: string;
  description: string;
  starsRequired: string;
  courseId: string; // '' = unassigned
  orderIndex: string;
  requiresPrevious: boolean;
}

export const defaultPhaseForm = (courseId: number | null = null): PhaseFormState => ({
  name: '',
  description: '',
  starsRequired: '0',
  courseId: courseId === null ? '' : String(courseId),
  orderIndex: '1',
  requiresPrevious: true,
});

export const phaseFormErrors = (form: PhaseFormState): string | null => {
  if (!form.name.trim()) return 'Phase name is required';
  const stars = parseInt(form.starsRequired, 10);
  if (Number.isNaN(stars) || stars < 0) return 'Stars required must be 0 or greater';
  const order = parseInt(form.orderIndex, 10);
  if (Number.isNaN(order) || order < 1) return 'Order must be 1 or greater';
  return null;
};

export const phaseFormBody = (form: PhaseFormState) => ({
  name: form.name.trim(),
  description: form.description.trim(),
  stars_required: parseInt(form.starsRequired, 10) || 0,
  course_id: form.courseId === '' ? null : parseInt(form.courseId, 10),
  order_index: parseInt(form.orderIndex, 10) || 1,
  requires_previous: form.requiresPrevious,
});

interface PhaseFieldsProps {
  form: PhaseFormState;
  setForm: React.Dispatch<React.SetStateAction<PhaseFormState>>;
  courses: Course[];
  disabled?: boolean;
  showOrder?: boolean;
}

const inputClass = 'w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all';
const labelClass = 'block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2';

export const PhaseFields: React.FC<PhaseFieldsProps> = ({ form, setForm, courses, disabled, showOrder = true }) => {
  const set = (patch: Partial<PhaseFormState>) => setForm((prev) => ({ ...prev, ...patch }));
  return (
    <>
      <div>
        <label className={labelClass}>Phase Name *</label>
        <input type="text" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g., Phase 1 — Java core and OOP" className={inputClass} disabled={disabled} required autoFocus />
      </div>

      <div>
        <label className={labelClass}>Description (optional)</label>
        <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Goal of this phase…" rows={3} className={`${inputClass} resize-none`} disabled={disabled} />
      </div>

      <div className={`grid gap-4 ${showOrder ? 'grid-cols-3' : 'grid-cols-1'}`}>
        <div className={showOrder ? 'col-span-2' : ''}>
          <label className={labelClass}>Course</label>
          <select value={form.courseId} onChange={(e) => set({ courseId: e.target.value })} className={inputClass} disabled={disabled}>
            <option value="">— Unassigned —</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {showOrder && (
          <div>
            <label className={labelClass}>Order in course</label>
            <input type="number" min="1" step="1" value={form.orderIndex} onChange={(e) => set({ orderIndex: e.target.value })} className={inputClass} disabled={disabled} />
          </div>
        )}
      </div>

      <fieldset className="rounded-xl border border-gray-200 dark:border-gray-600 p-4 space-y-4">
        <legend className="px-2 text-sm font-bold text-gray-600 dark:text-gray-300">How students reach this phase</legend>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={form.requiresPrevious} onChange={(e) => set({ requiresPrevious: e.target.checked })} className="mt-1 w-4 h-4 text-primary border-gray-300 rounded focus:ring-primary" disabled={disabled} />
          <span>
            <span className="block text-sm font-semibold text-gray-800 dark:text-gray-200">Locked until the previous phase is finished</span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">Every mandatory task of the previous phase must be approved first. Untick to let students start this phase at any time.</span>
          </span>
        </label>
        <div>
          <label className={labelClass}>Stars required (extra gate)</label>
          <div className="flex items-center space-x-3">
            <input type="number" value={form.starsRequired} onChange={(e) => set({ starsRequired: e.target.value })} min="0" step="1" className={`${inputClass} flex-1`} disabled={disabled} />
            <span className="material-icons text-yellow-400 text-2xl">stars</span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">0 = no star requirement.</p>
        </div>
      </fieldset>
    </>
  );
};
