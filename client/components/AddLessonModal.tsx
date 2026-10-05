import React, { useState } from 'react';

interface AddLessonModalProps {
  isOpen: boolean;
  phaseName: string;
  onClose: () => void;
  onSubmit: (title: string, description: string) => Promise<void>;
}

export const AddLessonModal: React.FC<AddLessonModalProps> = ({ isOpen, phaseName, onClose, onSubmit }) => {
  const [submitting, setSubmitting] = useState(false);
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !submitting && onClose()}>
      <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-xl w-96 max-w-[95vw]" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-xl font-bold mb-1 text-gray-800 dark:text-white">New Lesson</h3>
        <p className="text-xs text-gray-500 mb-4 truncate">Appended to the end of {phaseName}</p>
        <form onSubmit={async (e) => {
          e.preventDefault();
          const form = e.target as any;
          setSubmitting(true);
          try { await onSubmit(form.title.value, form.description.value); } finally { setSubmitting(false); }
        }}>
          <div className="mb-4">
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Lesson Title</label>
            <input name="title" placeholder="e.g., Week 7 — Code: JUnit 5" className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 focus:ring-2 focus:ring-primary outline-none" required autoFocus />
          </div>
          <div className="mb-6">
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Lesson Summary</label>
            <textarea name="description" placeholder="What will students learn in this lesson?" rows={4} className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 focus:ring-2 focus:ring-primary outline-none resize-none"></textarea>
          </div>
          <div className="flex justify-end space-x-3">
            <button type="button" onClick={onClose} disabled={submitting} className="px-5 py-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">Cancel</button>
            <button type="submit" disabled={submitting} className="px-5 py-2 bg-primary text-white font-bold rounded-lg shadow-md hover:shadow-lg transition-all disabled:opacity-50">{submitting ? 'Creating…' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};
