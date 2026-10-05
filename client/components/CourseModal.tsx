import React, { useState, useEffect } from 'react';
import { Course } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { apiUrl } from '../config';

interface CourseModalProps {
  isOpen: boolean;
  course: Course | null; // null = create
  onClose: () => void;
  onSuccess: () => void;
}

// Admin: create / rename / delete a course. Deleting a course keeps its phases (they become unassigned).
export const CourseModal: React.FC<CourseModalProps> = ({ isOpen, course, onClose, onSuccess }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName(course?.name || '');
    setDescription(course?.description || '');
    setError('');
  }, [isOpen, course]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) {
      setError('Course name is required');
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await fetch(apiUrl(course ? `/courses/${course.id}` : '/courses'), {
        method: course ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: name.trim(), description: description.trim() })
      });
      if (response.ok) {
        onSuccess();
        onClose();
      } else {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to save course');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!course) return;
    setShowDeleteConfirm(false);
    setIsSubmitting(true);
    try {
      const response = await fetch(apiUrl(`/courses/${course.id}`), { method: 'DELETE', credentials: 'include' });
      if (response.ok) {
        onSuccess();
        onClose();
      } else {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to delete course');
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
        title="Delete Course"
        message={`Delete "${course?.name}"? Its phases are kept but become unassigned, which hides them from students until you attach them to a course again. All enrolments in this course are removed and cannot be restored.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => !isSubmitting && onClose()}>
        <div className="bg-white dark:bg-gray-800 p-8 rounded-2xl shadow-2xl w-[560px] max-w-[95vw] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-3xl font-extrabold italic text-gray-800 dark:text-gray-100">
              {course ? 'Edit Course' : 'New Course'}
            </h2>
            <button onClick={onClose} disabled={isSubmitting} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors disabled:opacity-50">
              <span className="material-icons text-3xl">close</span>
            </button>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Course Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., QA Automation Engineer"
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                disabled={isSubmitting}
                required
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Description (optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder="What does a student achieve by finishing this course?"
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all resize-none"
                disabled={isSubmitting}
              />
            </div>

            <div className="flex justify-between items-center pt-2">
              {course ? (
                <button type="button" onClick={() => setShowDeleteConfirm(true)} disabled={isSubmitting} className="px-5 py-3 bg-red-600 text-white font-bold rounded-xl hover:bg-red-700 transition-colors shadow-md disabled:opacity-50 flex items-center space-x-2">
                  <span className="material-icons text-xl">delete</span>
                  <span>Delete</span>
                </button>
              ) : <div />}
              <div className="flex space-x-3">
                <button type="button" onClick={onClose} disabled={isSubmitting} className="px-6 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-bold rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button type="submit" disabled={isSubmitting} className="px-6 py-3 bg-primary text-white font-bold rounded-xl hover:bg-primary-dark transition-colors shadow-md disabled:opacity-50 flex items-center space-x-2">
                  <span className="material-icons text-xl">{course ? 'save' : 'add'}</span>
                  <span>{isSubmitting ? 'Saving...' : course ? 'Save' : 'Create Course'}</span>
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </>
  );
};
