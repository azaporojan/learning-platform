import React, { useState, useEffect } from 'react';
import { Course, Path } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { apiUrl } from '../config';
import { PhaseFields, PhaseFormState, defaultPhaseForm, phaseFormErrors, phaseFormBody } from './PhaseFields';

interface EditPathModalProps {
  isOpen: boolean;
  path: Path | null;
  courses: Course[];
  onClose: () => void;
  onSuccess: () => void;
}

// Admin: edit a phase (path): name, course, order, gating; or delete it with everything inside.
export const EditPathModal: React.FC<EditPathModalProps> = ({ isOpen, path, courses, onClose, onSuccess }) => {
  const [form, setForm] = useState<PhaseFormState>(defaultPhaseForm());
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (path) {
      setForm({
        name: path.title || '',
        description: path.description || '',
        starsRequired: String(path.requiredScore ?? 0),
        courseId: path.course_id === null || path.course_id === undefined ? '' : String(path.course_id),
        orderIndex: String(path.order_index ?? 1),
        requiresPrevious: path.requires_previous ?? true,
      });
      setError('');
    }
  }, [path]);

  if (!isOpen || !path) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = phaseFormErrors(form);
    if (problem) { setError(problem); return; }
    setError('');
    setIsSubmitting(true);
    try {
      const response = await fetch(apiUrl(`/paths/${path.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(phaseFormBody(form))
      });
      if (response.ok) {
        onSuccess();
        onClose();
      } else {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to update phase');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteConfirm = async () => {
    setShowDeleteConfirm(false);
    setIsSubmitting(true);
    try {
      const response = await fetch(apiUrl(`/paths/${path.id}`), { method: 'DELETE', credentials: 'include' });
      if (response.ok) {
        onSuccess();
        onClose();
      } else {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to delete phase');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="Delete Phase"
        message={`Are you sure you want to delete "${path.title}"? This will delete all lessons, tasks and student submissions in this phase.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => !isSubmitting && onClose()}>
        <div className="bg-white dark:bg-gray-800 p-8 rounded-2xl shadow-2xl w-[600px] max-w-[95vw] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-3xl font-extrabold italic text-gray-800 dark:text-gray-100">Edit Phase</h2>
            <button onClick={onClose} disabled={isSubmitting} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors disabled:opacity-50">
              <span className="material-icons text-3xl">close</span>
            </button>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg text-red-700 dark:text-red-300">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <PhaseFields form={form} setForm={setForm} courses={courses} disabled={isSubmitting} />

            <div className="flex justify-between items-center pt-2">
              <button type="button" onClick={() => setShowDeleteConfirm(true)} disabled={isSubmitting} className="px-5 py-3 bg-red-600 text-white font-bold rounded-xl hover:bg-red-700 transition-colors shadow-md disabled:opacity-50 flex items-center space-x-2">
                <span className="material-icons text-xl">delete</span>
                <span>Delete</span>
              </button>
              <div className="flex space-x-3">
                <button type="button" onClick={onClose} disabled={isSubmitting} className="px-6 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-bold rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button type="submit" disabled={isSubmitting} className="px-6 py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary-dark transition-colors shadow-md disabled:opacity-50 flex items-center space-x-2">
                  <span className="material-icons text-xl">save</span>
                  <span>{isSubmitting ? 'Saving...' : 'Save Changes'}</span>
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </>
  );
};
