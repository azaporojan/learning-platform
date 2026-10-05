import React, { useState, useEffect } from 'react';

interface AddTaskModalProps {
  isOpen: boolean;
  lessonTitle: string;
  onClose: () => void;
  onSubmit: (title: string, type: 'mandatory' | 'optional', xp: number, deadline: string | null) => Promise<void>;
}

export const AddTaskModal: React.FC<AddTaskModalProps> = ({ isOpen, lessonTitle, onClose, onSubmit }) => {
  const [taskType, setTaskType] = useState<'mandatory' | 'optional'>('mandatory');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { if (isOpen) setTaskType('mandatory'); }, [isOpen]);
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !submitting && onClose()}>
      <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-xl w-96 max-w-[95vw]" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-xl font-bold mb-1 text-gray-800 dark:text-white">Add Task</h3>
        <p className="text-xs text-gray-500 mb-4 truncate">Lesson: {lessonTitle}</p>
        <form onSubmit={async (e) => {
          e.preventDefault();
          const form = e.target as any;
          setSubmitting(true);
          try {
            await onSubmit(form.title.value, form.type.value, parseInt(form.xp.value, 10) || 0, form.deadline.value || null);
          } finally { setSubmitting(false); }
        }}>
          <input name="title" placeholder="Task Title" className="w-full mb-4 p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 outline-none focus:ring-2 focus:ring-primary" required autoFocus />

          <div className="mb-4">
            <label className="block text-xs font-bold text-gray-500 mb-1">Type</label>
            <select name="type" className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 outline-none" onChange={(e) => setTaskType(e.target.value as 'mandatory' | 'optional')} value={taskType}>
              <option value="mandatory">Mandatory (Blocker)</option>
              <option value="optional">Optional (Bonus XP)</option>
            </select>
          </div>

          <div className="flex space-x-4 mb-6">
            <div className="w-1/2">
              <label className="block text-xs font-bold text-gray-500 mb-1">XP Reward</label>
              <input type="number" name="xp" defaultValue="10" min="0" className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 outline-none" />
            </div>
            <div className="w-1/2">
              <label className="block text-xs font-bold text-gray-500 mb-1">
                Deadline {taskType === 'optional' && <span className="text-gray-400 font-normal">(Optional)</span>}
              </label>
              <input type="date" name="deadline" className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 outline-none" required={taskType === 'mandatory'} />
            </div>
          </div>

          <div className="flex justify-end space-x-3">
            <button type="button" onClick={onClose} className="px-5 py-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors" disabled={submitting}>Cancel</button>
            <button type="submit" className="px-5 py-2 bg-primary text-white font-bold rounded-lg shadow-md hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed" disabled={submitting}>
              {submitting ? 'Adding...' : 'Add Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
