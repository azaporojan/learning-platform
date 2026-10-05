import React, { useState, useEffect } from 'react';
import { apiUrl } from '../config';
import { Course } from '../types';
import { PhaseFields, PhaseFormState, defaultPhaseForm, phaseFormErrors, phaseFormBody } from './PhaseFields';

interface AddPathModalProps {
  isOpen: boolean;
  courses: Course[];
  defaultCourseId?: number | null;
  onClose: () => void;
  onSuccess: () => void;
}

// Admin: create a phase (path) and attach it to a course. It goes to the end of that course's road.
export const AddPathModal: React.FC<AddPathModalProps> = ({ isOpen, courses, defaultCourseId = null, onClose, onSuccess }) => {
  const [form, setForm] = useState<PhaseFormState>(defaultPhaseForm(defaultCourseId));
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setForm(defaultPhaseForm(defaultCourseId));
      setError('');
    }
  }, [isOpen, defaultCourseId]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = phaseFormErrors(form);
    if (problem) { setError(problem); return; }
    setError('');
    setIsSubmitting(true);
    try {
      const body = phaseFormBody(form);
      delete (body as any).order_index; // a new phase is appended; order is editable afterwards
      const response = await fetch(apiUrl('/paths'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
      });
      if (response.ok) {
        onSuccess();
        onClose();
      } else {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to create phase');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => !isSubmitting && onClose()}>
      <div className="bg-white dark:bg-gray-800 p-8 rounded-2xl shadow-2xl w-[600px] max-w-[95vw] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-extrabold italic text-gray-800 dark:text-gray-100">New Phase</h2>
          <button onClick={onClose} disabled={isSubmitting} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors disabled:opacity-50">
            <span className="material-icons text-3xl">close</span>
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg text-red-700 dark:text-red-300">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <PhaseFields form={form} setForm={setForm} courses={courses} disabled={isSubmitting} showOrder={false} />
          <div className="flex justify-end space-x-3 pt-2">
            <button type="button" onClick={onClose} disabled={isSubmitting} className="px-6 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-bold rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={isSubmitting} className="px-6 py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary-dark transition-colors shadow-md disabled:opacity-50 flex items-center space-x-2">
              <span className="material-icons text-xl">add</span>
              <span>{isSubmitting ? 'Creating...' : 'Create Phase'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
