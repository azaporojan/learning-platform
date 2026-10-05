import React, { useState, useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { useDialog } from '../hooks/useDialog';
import { AlertDialog } from './AlertDialog';
import { apiUrl } from '../config';
import { ConfirmDialog } from './ConfirmDialog';

interface Task {
  id: number;
  title: string;
  type: 'mandatory' | 'optional';
  xp_reward: number;
  deadline?: string;
  description?: string;
}

interface Submission {
  id: number;
  user_id: number;
  user_name: string;
  user_email: string;
  file_name: string | null;
  file_path: string | null;
  file_size: number | null;
  comment?: string | null;
  submitted_at: string;
  status: 'pending' | 'approved' | 'rejected' | null;
}

// A submission's text part: plain text with http(s) links made clickable (PR links, Jira tickets…).
const SubmissionComment: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
  return (
    <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        /^https?:\/\//.test(part)
          ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 underline break-all" onClick={(e) => e.stopPropagation()}>{part}</a>
          : <React.Fragment key={i}>{part}</React.Fragment>
      )}
    </p>
  );
};

interface TaskModalProps {
  task: Task;
  isOpen: boolean;
  onClose: () => void;
  isAdmin: boolean;
  currentUserId: number;
  currentUser?: any;
  onUpdate?: () => void;
}

export const TaskModal: React.FC<TaskModalProps> = ({
  task,
  isOpen,
  onClose,
  isAdmin,
  currentUserId,
  currentUser,
  onUpdate
}) => {
  const [mode, setMode] = useState<'view' | 'edit' | 'submissions'>('view');
  const [editData, setEditData] = useState({
    title: task.title,
    type: task.type,
    xp_reward: task.xp_reward,
    deadline: task.deadline || '',
    description: task.description || ''
  });
  const [originalData, setOriginalData] = useState({
    title: task.title,
    type: task.type,
    xp_reward: task.xp_reward,
    deadline: task.deadline || '',
    description: task.description || ''
  });
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [comment, setComment] = useState('');
  const [uploading, setUploading] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState<string | null>(null);
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [rejectComment, setRejectComment] = useState('');
  const [rejectingStudentId, setRejectingStudentId] = useState<number | null>(null);

  // Dialog hooks
  const {
    alertState,
    confirmState,
    showAlert,
    hideAlert,
    showConfirm,
    hideConfirm,
    handleConfirm
  } = useDialog();

  // Initialize Tiptap editor
  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({
        HTMLAttributes: {
          class: 'max-w-full h-auto rounded-lg my-4',
        },
      }),
      Link.configure({
        openOnClick: false,
      }),
    ],
    content: editData.description || '',
    editable: mode === 'edit',
    onUpdate: ({ editor }) => {
      setEditData({ ...editData, description: editor.getHTML() });
    },
  });

  // Update editData when task changes
  useEffect(() => {
    const data = {
      title: task.title,
      type: task.type,
      xp_reward: task.xp_reward,
      deadline: task.deadline || '',
      description: task.description || ''
    };
    setEditData(data);
    setOriginalData(data);
    if (editor) {
      editor.commands.setContent(task.description || '');
    }
  }, [task]);

  // Update editor editable state when mode changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(mode === 'edit');
    }
  }, [mode, editor]);

  // Check if there are unsaved changes
  const hasUnsavedChanges = () => {
    if (mode !== 'edit') return false;
    return (
      editData.title !== originalData.title ||
      editData.type !== originalData.type ||
      editData.xp_reward !== originalData.xp_reward ||
      editData.deadline !== originalData.deadline ||
      editData.description !== originalData.description
    );
  };

  // Prevent page refresh/close with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges() && isOpen) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [editData, originalData, mode, isOpen]);

  // Handle image upload for Tiptap
  const addImage = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e: any) => {
      const file = e.target.files[0];
      if (file && editor) {
        const formData = new FormData();
        formData.append('image', file);

        try {
          const response = await fetch(apiUrl('/upload-image'), {
            method: 'POST',
            credentials: 'include',
            body: formData
          });

          if (response.ok) {
            const data = await response.json();
            editor.chain().focus().setImage({ src: data.url }).run();
          } else {
            showAlert('Error', 'Failed to upload image', 'danger');
          }
        } catch (error) {
          console.error('Image upload error:', error);
          showAlert('Error', 'Error uploading image', 'danger');
        }
      }
    };
    input.click();
  };

  useEffect(() => {
    if (isOpen) {
      // Always fetch submissions when modal opens (for count in tab)
      fetchSubmissions();
      if (mode === 'submissions') {
        setSelectedStudent(null); // Reset selection when entering submissions tab
      }

      // Mark task as viewed for students (remove NEW badge)
      if (!isAdmin) {
        markTaskAsViewed();
      }
    }
  }, [isOpen, mode, isAdmin]);

  // Function to mark task as viewed by student
  const markTaskAsViewed = async () => {
    try {
      await fetch(apiUrl(`/tasks/${task.id}/mark-viewed`), {
        method: 'POST',
          credentials: 'include'
        });
      } catch (error) {
      console.error('Failed to mark task as viewed:', error);
    }
  };

  const fetchSubmissions = async () => {
    try {
      const res = await fetch(apiUrl(`/tasks/${task.id}/submissions`), {
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        setSubmissions(data);
      }
    } catch (err) {
      console.error('Failed to fetch submissions:', err);
    }
  };

  const handleSave = async () => {
    try {
      const res = await fetch(apiUrl(`/tasks/${task.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: editData.title,
          type: editData.type,
          xp: editData.xp_reward,
          deadline: editData.deadline,
          description: editData.description
        })
      });

      if (res.ok) {
        // Update local task object with new data
        task.title = editData.title;
        task.type = editData.type;
        task.xp_reward = editData.xp_reward;
        task.deadline = editData.deadline;
        task.description = editData.description;

        // Update originalData to reflect saved state
        setOriginalData({
          title: editData.title,
          type: editData.type,
          xp_reward: editData.xp_reward,
          deadline: editData.deadline,
          description: editData.description
        });

        setMode('view');
        if (onUpdate) onUpdate();
      } else {
        const errorData = await res.json();
        console.error('Update failed:', errorData);
        showAlert('Error', 'Failed to update task: ' + (errorData.error || 'Unknown error'), 'danger');
      }
    } catch (err) {
      console.error('Failed to update task:', err);
      showAlert('Error', 'Failed to update task: ' + err, 'danger');
    }
  };

  // Handle close with unsaved changes check
  const handleClose = () => {
    if (hasUnsavedChanges()) {
      setPendingAction(() => () => {
        setMode('view');
        onClose();
      });
      setShowUnsavedWarning(true);
    } else {
      setMode('view');
      onClose();
    }
  };

  // Handle mode change with unsaved changes check
  const handleModeChange = (newMode: 'view' | 'edit' | 'submissions') => {
    if (hasUnsavedChanges() && newMode !== 'edit') {
      setPendingAction(() => () => setMode(newMode));
      setShowUnsavedWarning(true);
    } else {
      setMode(newMode);
    }
  };

  // Confirm discard changes
  const handleDiscardChanges = () => {
    setEditData(originalData);
    if (editor) {
      editor.commands.setContent(originalData.description || '');
    }
    setShowUnsavedWarning(false);
    if (pendingAction) {
      pendingAction();
      setPendingAction(null);
    }
  };

  // Cancel discard
  const handleCancelDiscard = () => {
    setShowUnsavedWarning(false);
    setPendingAction(null);
  };

  const handleDeleteClick = () => {
    showConfirm(
      'Delete Task',
      'Are you sure you want to delete this task? This action cannot be undone.',
      handleDeleteConfirm,
      'danger'
    );
  };

  const handleDeleteConfirm = async () => {
    try {
      const res = await fetch(apiUrl(`/tasks/${task.id}`), {
        method: 'DELETE',
        credentials: 'include'
      });

      if (res.ok) {
        if (onUpdate) onUpdate();
        onClose();
      }
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  };

  const handleAddFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setUploadFiles([...uploadFiles, ...files]);
    // Reset input so the same file can be added again if needed
    e.target.value = '';
  };

  const handleRemoveFile = (index: number) => {
    setUploadFiles(uploadFiles.filter((_, i) => i !== index));
  };

  const canSubmit = comment.trim().length > 0 || uploadFiles.length > 0;

  // A submission is a comment (link to a PR / Jira ticket / notes), files, or both. The comment
  // travels with the first file; further files are separate submissions.
  const handleTurnIn = async () => {
    if (!canSubmit) return;

    setUploading(true);

    try {
      const requests: FormData[] = [];
      if (uploadFiles.length === 0) {
        const formData = new FormData();
        formData.append('comment', comment.trim());
        requests.push(formData);
      } else {
        uploadFiles.forEach((file, index) => {
          const formData = new FormData();
          formData.append('file', file);
          if (index === 0 && comment.trim()) formData.append('comment', comment.trim());
          requests.push(formData);
        });
      }

      for (const body of requests) {
        const res = await fetch(apiUrl(`/tasks/${task.id}/submit`), { method: 'POST', credentials: 'include', body });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Submission failed (${res.status})`);
        }
      }

      setUploadFiles([]);
      setComment('');
      fetchSubmissions();
      if (onUpdate) onUpdate();
    } catch (err: any) {
      console.error('Failed to submit:', err);
      showAlert('Error', err?.message || 'Failed to submit', 'danger');
    } finally {
      setUploading(false);
    }
  };

  const downloadFile = (submissionId: number) => {
    window.open(apiUrl(`/submissions/download/${submissionId}`), '_blank');
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  const confirmDeleteSubmission = (id: number) => {
    showConfirm(
      'Delete Submission',
      'Are you sure you want to delete this submission? This action cannot be undone.',
      () => handleDeleteSubmission(id),
      'danger'
    );
  };

  const handleApproveSubmission = async (id: number) => {
    try {
      const res = await fetch(apiUrl(`/submissions/${id}/approve`), {
        method: 'POST',
        credentials: 'include'
      });

      if (res.ok) {
        fetchSubmissions();
        if (onUpdate) onUpdate();
        showAlert('Success', 'Submission approved successfully!', 'success');
      } else {
        const data = await res.json();
        showAlert('Error', data.error || 'Failed to approve submission', 'danger');
      }
    } catch (err) {
      console.error('Failed to approve submission:', err);
      showAlert('Error', 'Failed to approve submission', 'danger');
    }
  };

  const handleApproveAll = async (studentId: number) => {
    try {
      const res = await fetch(apiUrl(`/tasks/${task.id}/approve-all`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ studentId })
      });

      if (res.ok) {
        fetchSubmissions();
        if (onUpdate) onUpdate();
        showAlert('Success', 'All submissions approved! Task completed for student.', 'success');
      } else {
        const data = await res.json();
        showAlert('Error', data.error || 'Failed to approve submissions', 'danger');
      }
    } catch (err) {
      console.error('Failed to approve all:', err);
      showAlert('Error', 'Failed to approve submissions', 'danger');
    }
  };

  const handleRejectClick = (studentId: number) => {
    setRejectingStudentId(studentId);
    setRejectComment('');
    setShowRejectDialog(true);
  };

  const handleRejectConfirm = async () => {
    if (!rejectingStudentId || !rejectComment.trim()) {
      showAlert('Error', 'Please provide a reason for rejection', 'danger');
      return;
    }

    try {
      const res = await fetch(apiUrl(`/tasks/${task.id}/reject-all`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          studentId: rejectingStudentId,
          comment: rejectComment.trim()
        })
      });

      if (res.ok) {
        fetchSubmissions();
        if (onUpdate) onUpdate();
        setShowRejectDialog(false);
        setRejectComment('');
        setRejectingStudentId(null);
        showAlert('Success', 'Submissions rejected. Student has been notified.', 'success');
      } else {
        const data = await res.json();
        showAlert('Error', data.error || 'Failed to reject submissions', 'danger');
      }
    } catch (err) {
      console.error('Failed to reject submissions:', err);
      showAlert('Error', 'Failed to reject submissions', 'danger');
    }
  };

  const handleRejectCancel = () => {
    setShowRejectDialog(false);
    setRejectComment('');
    setRejectingStudentId(null);
  };

  const handleDeleteSubmission = async (id: number) => {
    try {
      const res = await fetch(apiUrl(`/submissions/${id}`), {
        method: 'DELETE',
        credentials: 'include'
      });

      if (res.ok) {
        fetchSubmissions();
        if (onUpdate) onUpdate();
      } else {
        const data = await res.json();
        showAlert('Error', data.error || 'Failed to delete submission', 'danger');
      }
    } catch (err) {
      console.error('Failed to delete submission:', err);
      showAlert('Error', 'Failed to delete submission', 'danger');
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const renderStatusChip = (status: Submission['status']) => {
    const normalized = status ?? 'pending';

    if (normalized === 'approved') {
      return (
        <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 rounded text-xs font-bold border border-green-200 dark:border-green-800">
          Approved
        </span>
      );
    }

    if (normalized === 'rejected') {
      return (
        <span className="px-2 py-0.5 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded text-xs font-bold border border-red-200 dark:border-red-800">
          Rejected
        </span>
      );
    }

    return (
      <span className="px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 rounded text-xs font-bold border border-yellow-200 dark:border-yellow-800">
        Pending
      </span>
    );
  };

  if (!isOpen) return null;

  return (
    <>
      <AlertDialog
        isOpen={alertState.isOpen}
        title={alertState.title}
        message={alertState.message}
        variant={alertState.variant}
        onConfirm={hideAlert}
      />

      <ConfirmDialog
        isOpen={confirmState.isOpen}
        title={confirmState.title}
        message={confirmState.message}
        variant={confirmState.variant}
        onConfirm={handleConfirm}
        onCancel={hideConfirm}
      />

      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={handleClose}>
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[1100px] max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {task.type === 'mandatory' && (
                <span className="material-icons text-red-500">priority_high</span>
              )}
              <h2 className="text-2xl font-bold text-gray-800 dark:text-white">
                {mode === 'edit' ? 'Edit Task' : task.title}
              </h2>
            </div>
            <button onClick={handleClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
              <span className="material-icons">close</span>
            </button>
          </div>

          {/* Mode Tabs (Admin Only) */}
          {isAdmin && mode !== 'edit' && (
            <div className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <button
                onClick={() => handleModeChange('view')}
                className={`px-6 py-3 font-semibold transition-colors ${mode === 'view'
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                  }`}
              >
                Task Details
              </button>
              <button
                onClick={() => handleModeChange('submissions')}
                className={`px-6 py-3 font-semibold transition-colors ${mode === 'submissions'
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                  }`}
              >
                Submissions ({new Set(submissions.map(s => s.user_email)).size})
              </button>
            </div>
          )}

          {/* Content */}
          <div className="flex-grow overflow-y-auto p-6">
            {mode === 'view' && (
              <div className="space-y-6">
                {/* Task Info */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-sm font-bold text-gray-500">TYPE</span>
                    <p className="text-lg capitalize">{task.type}</p>
                  </div>
                  <div>
                    <span className="text-sm font-bold text-gray-500">XP REWARD</span>
                    <p className="text-lg">{task.xp_reward} XP</p>
                  </div>
                  {task.deadline && (
                    <div className="col-span-2">
                      <span className="text-sm font-bold text-gray-500">DEADLINE</span>
                      <p className="text-lg">{formatDate(task.deadline)}</p>
                    </div>
                  )}
                </div>

                {/* Description */}
                <div>
                  <span className="text-sm font-bold text-gray-500 mb-2 block">REQUIREMENTS</span>
                  <div
                    className="prose dark:prose-invert max-w-none bg-gray-50 dark:bg-gray-900 p-4 rounded-lg"
                    dangerouslySetInnerHTML={{
                      __html: task.description || '<p className="text-gray-400 italic">No requirements specified yet.</p>'
                    }}
                  />
                </div>

                {/* Student Upload Section */}
                {!isAdmin && (
                  <>
                    <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
                      <span className="text-sm font-bold text-gray-500 mb-3 block">YOUR WORK</span>

                      {/* Comment: PR link, Jira ticket, notes */}
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        rows={3}
                        maxLength={4000}
                        placeholder="Link to your pull request, Jira ticket or repo, plus any notes for the reviewer…"
                        className="w-full mb-3 p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 text-sm focus:ring-2 focus:ring-primary outline-none resize-y"
                        disabled={uploading}
                      />

                      {/* Files to Upload */}
                      {uploadFiles.length > 0 && (
                        <div className="mb-4 space-y-2">
                          {uploadFiles.map((file, index) => (
                            <div key={index} className="flex items-center justify-between bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
                              <div className="flex items-center space-x-2 flex-grow">
                                <span className="material-icons text-blue-500">insert_drive_file</span>
                                <span className="text-sm text-gray-800 dark:text-gray-200 truncate">{file.name}</span>
                                <span className="text-xs text-gray-500">({formatFileSize(file.size)})</span>
                              </div>
                              <button
                                onClick={() => handleRemoveFile(index)}
                                className="text-red-500 hover:text-red-700 ml-2"
                                type="button"
                              >
                                <span className="material-icons text-sm">close</span>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Add Files Button */}
                      <div className="flex items-center space-x-3">
                        <input
                          type="file"
                          id="file-upload"
                          className="hidden"
                          onChange={handleAddFiles}
                          accept=".pdf,.doc,.docx,.txt,.zip,.rar,.jpg,.jpeg,.png,.gif,.html,.htm,.css,.js"
                          multiple
                        />
                        <label
                          htmlFor="file-upload"
                          className="px-4 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg cursor-pointer transition-colors flex items-center space-x-2"
                        >
                          <span className="material-icons">add</span>
                          <span>Add File</span>
                        </label>

                        {/* Submit Button */}
                        <button
                          onClick={handleTurnIn}
                          disabled={uploading || !canSubmit}
                          title={canSubmit ? 'Submit your work' : 'Write a comment or add a file first'}
                          className="px-6 py-2 bg-primary hover:bg-primary/90 text-white font-bold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2 shadow-lg"
                        >
                          {uploading ? (
                            <>
                              <span className="material-icons animate-spin">refresh</span>
                              <span>Submitting...</span>
                            </>
                          ) : (
                            <>
                              <span className="material-icons">send</span>
                              <span>Submit</span>
                            </>
                          )}
                        </button>
                      </div>
                      <p className="text-xs text-gray-400 mt-2">A comment, a file, or both. Mandatory tasks are unlocked once an admin approves your submission.</p>
                    </div>

                    {/* Student's Own Submissions */}
                    {submissions.filter(s => s.user_email === (currentUser?.email || '')).length > 0 && (
                      <div className="border-t border-gray-200 dark:border-gray-700 pt-6 mt-6">
                        <span className="text-sm font-bold text-gray-500 mb-3 block">YOUR SUBMISSIONS</span>
                        <div className="space-y-3">
                          {submissions
                            .filter(s => s.user_email === (currentUser?.email || ''))
                            .map(sub => (
                              <div key={sub.id} className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
                                <div className="flex items-center justify-between">
                                  <div className="flex-grow">
                                    <div className="flex items-center space-x-2 mb-2">
                                      <span className="material-icons text-green-500 text-sm">check_circle</span>
                                      <span className="font-bold text-gray-800 dark:text-white">Submitted</span>
                                      {renderStatusChip(sub.status)}
                                    </div>
                                    {sub.comment && <div className="mb-2"><SubmissionComment text={sub.comment} /></div>}
                                    <div className="flex items-center space-x-4 text-sm text-gray-600 dark:text-gray-400">
                                      {sub.file_name && (
                                        <span className="flex items-center space-x-1">
                                          <span className="material-icons text-sm">insert_drive_file</span>
                                          <span>{sub.file_name}</span>
                                        </span>
                                      )}
                                      {sub.file_size !== null && <span>{formatFileSize(sub.file_size)}</span>}
                                      <span>{formatDate(sub.submitted_at)}</span>
                                    </div>
                                  </div>
                                  <div className="flex items-center space-x-2">
                                    {/* Only show delete button if NOT approved */
                                      sub.status !== 'approved' && (
                                        <button
                                          onClick={() => confirmDeleteSubmission(sub.id)}
                                          className="px-3 py-2 bg-red-100 hover:bg-red-200 dark:bg-red-900/30 dark:hover:bg-red-900/50 text-red-600 dark:text-red-400 rounded-lg transition-colors flex items-center space-x-1"
                                          title="Delete Submission"
                                        >
                                          <span className="material-icons text-sm">delete</span>
                                        </button>
                                      )}
                                    {sub.file_name && (
                                      <button
                                        onClick={() => downloadFile(sub.id)}
                                        className="px-3 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded-lg transition-colors flex items-center space-x-1"
                                      >
                                        <span className="material-icons text-sm">download</span>
                                        <span className="text-sm">Download</span>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {mode === 'edit' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Task Title</label>
                  <input
                    type="text"
                    value={editData.title}
                    onChange={(e) => setEditData({ ...editData, title: e.target.value })}
                    className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 focus:ring-2 focus:ring-primary outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Type</label>
                    <select
                      value={editData.type}
                      onChange={(e) => setEditData({ ...editData, type: e.target.value as 'mandatory' | 'optional' })}
                      className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 focus:ring-2 focus:ring-primary outline-none"
                    >
                      <option value="mandatory">Mandatory</option>
                      <option value="optional">Optional</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">XP Reward</label>
                    <input
                      type="number"
                      value={editData.xp_reward}
                      onChange={(e) => setEditData({ ...editData, xp_reward: parseInt(e.target.value) })}
                      className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 focus:ring-2 focus:ring-primary outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Deadline (Optional)</label>
                  <input
                    type="datetime-local"
                    value={editData.deadline}
                    onChange={(e) => setEditData({ ...editData, deadline: e.target.value })}
                    className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 focus:ring-2 focus:ring-primary outline-none"
                  />
                </div>

                <div>
                  <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Requirements</label>
                  {editor && (
                    <div className="rounded-xl overflow-hidden border border-gray-200 dark:border-gray-600">
                      {/* Toolbar */}
                      <div className="bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-2 flex flex-wrap gap-1">
                        <button
                          onClick={() => editor.chain().focus().toggleBold().run()}
                          className={`px-3 py-1 rounded ${editor.isActive('bold') ? 'bg-primary text-white' : 'bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                          type="button"
                        >
                          <strong>B</strong>
                        </button>
                        <button
                          onClick={() => editor.chain().focus().toggleItalic().run()}
                          className={`px-3 py-1 rounded ${editor.isActive('italic') ? 'bg-primary text-white' : 'bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                          type="button"
                        >
                          <em>I</em>
                        </button>
                        <button
                          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                          className={`px-3 py-1 rounded ${editor.isActive('heading', { level: 2 }) ? 'bg-primary text-white' : 'bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                          type="button"
                        >
                          H2
                        </button>
                        <button
                          onClick={() => editor.chain().focus().toggleBulletList().run()}
                          className={`px-3 py-1 rounded ${editor.isActive('bulletList') ? 'bg-primary text-white' : 'bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                          type="button"
                        >
                          • List
                        </button>
                        <button
                          onClick={() => editor.chain().focus().toggleOrderedList().run()}
                          className={`px-3 py-1 rounded ${editor.isActive('orderedList') ? 'bg-primary text-white' : 'bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                          type="button"
                        >
                          1. List
                        </button>
                        <button
                          onClick={addImage}
                          className="px-3 py-1 rounded bg-green-500 hover:bg-green-600 text-white flex items-center gap-1"
                          type="button"
                        >
                          <span className="material-icons text-sm">image</span>
                          Image
                        </button>
                      </div>

                      {/* Editor Content */}
                      <EditorContent
                        editor={editor}
                        className="prose dark:prose-invert max-w-none p-4 min-h-[300px] focus:outline-none"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {mode === 'submissions' && (
              <div className="space-y-4">
                {submissions.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">
                    <span className="material-icons text-6xl mb-4">inbox</span>
                    <p>No submissions yet</p>
                  </div>
                ) : selectedStudent ? (
                  // Show selected student's files
                  <div>
                    <button
                      onClick={() => setSelectedStudent(null)}
                      className="flex items-center space-x-2 text-primary hover:text-primary/80 mb-4"
                    >
                      <span className="material-icons">arrow_back</span>
                      <span>Back to students</span>
                    </button>

                    <div className="space-y-3">
                      {submissions
                        .filter(sub => sub.user_email === selectedStudent)
                        .map(sub => (
                          <div key={sub.id} className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
                            <div className="flex items-center justify-between">
                              <div className="flex-grow min-w-0">
                                {sub.comment && <div className="mb-2"><SubmissionComment text={sub.comment} /></div>}
                                <div className="flex items-center flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
                                  {sub.file_name ? (
                                    <span className="flex items-center space-x-1">
                                      <span className="material-icons text-sm">insert_drive_file</span>
                                      <span className="font-medium">{sub.file_name}</span>
                                    </span>
                                  ) : (
                                    <span className="flex items-center space-x-1 italic">
                                      <span className="material-icons text-sm">chat</span>
                                      <span>Comment only</span>
                                    </span>
                                  )}
                                  {sub.file_size !== null && <span>{formatFileSize(sub.file_size)}</span>}
                                  <span>{formatDate(sub.submitted_at)}</span>

                                  {/* Status Chip */}
                                  {renderStatusChip(sub.status)}
                                </div>
                              </div>
                              <div className="flex items-center space-x-2 ml-3">
                                {sub.file_name && (
                                  <button
                                    onClick={() => downloadFile(sub.id)}
                                    className="px-3 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg transition-colors flex items-center space-x-2"
                                  >
                                    <span className="material-icons text-sm">download</span>
                                    <span>Download</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                    </div>

                    {/* Approve All & Reject Buttons at Bottom */}
                    {(() => {
                      const studentSubmissions = submissions.filter(s => s.user_email === selectedStudent);
                      const hasPending = studentSubmissions.some(s => !s.status || s.status === 'pending');
                      const studentId = studentSubmissions[0]?.user_id;

                      if (studentId && hasPending) {
                        return (
                          <div className="mt-6 space-y-3">
                            <button
                              onClick={() => handleApproveAll(studentId)}
                              className="w-full py-4 bg-green-500 hover:bg-green-600 text-white rounded-xl shadow-lg transition-all transform hover:scale-[1.02] flex items-center justify-center space-x-2 font-bold text-lg"
                            >
                              <span className="material-icons">task_alt</span>
                              <span>
                                {task.type === 'mandatory'
                                  ? 'Approve Task & Unlock Next Steps'
                                  : 'Approve Task & Grant XP'}
                              </span>
                            </button>
                            <button
                              onClick={() => handleRejectClick(studentId)}
                              className="w-full py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl shadow-lg transition-all transform hover:scale-[1.02] flex items-center justify-center space-x-2 font-semibold"
                            >
                              <span className="material-icons">cancel</span>
                              <span>Reject Task</span>
                            </button>
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                ) : (
                  // Show list of students
                  <div className="space-y-3">
                    {(() => {
                      // Group submissions by user
                      const studentMap = new Map<string, { name: string, email: string, count: number, latestDate: string, hasPending: boolean }>();
                      submissions.forEach(sub => {
                        const isPending = !sub.status || sub.status === 'pending';

                        if (!studentMap.has(sub.user_email)) {
                          studentMap.set(sub.user_email, {
                            name: sub.user_name,
                            email: sub.user_email,
                            count: 1,
                            latestDate: sub.submitted_at,
                            hasPending: isPending
                          });
                        } else {
                          const existing = studentMap.get(sub.user_email)!;
                          existing.count++;
                          if (new Date(sub.submitted_at) > new Date(existing.latestDate)) {
                            existing.latestDate = sub.submitted_at;
                          }
                          if (isPending) existing.hasPending = true;
                        }
                      });

                      return Array.from(studentMap.values()).map(student => (
                        <div
                          key={student.email}
                          onClick={() => setSelectedStudent(student.email)}
                          className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg hover:shadow-md transition-shadow cursor-pointer border-l-4 border-primary"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-3">
                              <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center relative">
                                <span className="material-icons text-primary">person</span>
                                {student.hasPending && (
                                  <span className="absolute top-0 right-0 w-3 h-3 bg-red-500 border-2 border-white dark:border-gray-900 rounded-full"></span>
                                )}
                              </div>
                              <div>
                                <p className="font-bold text-gray-800 dark:text-white">{student.name}</p>
                                <p className="text-sm text-gray-500">{student.email}</p>
                                <div className="flex items-center space-x-3 mt-1 text-xs text-gray-600 dark:text-gray-400">
                                  <span className="flex items-center space-x-1">
                                    <span className="material-icons text-xs">insert_drive_file</span>
                                    <span>{student.count} file{student.count > 1 ? 's' : ''}</span>
                                  </span>
                                  <span>•</span>
                                  <span>Last: {formatDate(student.latestDate)}</span>
                                  {student.hasPending && (
                                    <span className="text-red-500 font-bold">• Review Needed</span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <span className="material-icons text-gray-400">chevron_right</span>
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-6 border-t border-gray-200 dark:border-gray-700 flex justify-between">
            {isAdmin && mode === 'view' && (
              <div className="flex space-x-2">
                <button
                  onClick={() => setMode('edit')}
                  className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors flex items-center space-x-2"
                >
                  <span className="material-icons text-sm">edit</span>
                  <span>Edit</span>
                </button>
                <button
                  onClick={handleDeleteClick}
                  className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors flex items-center space-x-2"
                >
                  <span className="material-icons text-sm">delete</span>
                  <span>Delete</span>
                </button>
              </div>
            )}

            {mode === 'edit' && (
              <div className="flex space-x-2">
                <button
                  onClick={() => handleModeChange('view')}
                  className="px-4 py-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg transition-colors"
                >
                  Save Changes
                </button>
              </div>
            )}

            {mode !== 'edit' && (
              <button
                onClick={handleClose}
                className="px-5 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded-lg transition-colors ml-auto"
              >
                Close
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Unsaved Changes Warning Modal */}
      {showUnsavedWarning && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[500px] p-8">
            <div className="flex items-center mb-4">
              <span className="material-icons text-yellow-500 text-4xl mr-3">warning</span>
              <h3 className="text-2xl font-bold text-gray-800 dark:text-white">Unsaved Changes</h3>
            </div>

            <p className="text-gray-600 dark:text-gray-300 mb-6 text-lg">
              You have unsaved changes. Are you sure you want to discard them?
            </p>

            <div className="flex justify-end space-x-3">
              <button
                onClick={handleCancelDiscard}
                className="px-6 py-3 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded-lg transition-colors font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleDiscardChanges}
                className="px-6 py-3 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors font-semibold"
              >
                Discard Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Task Dialog */}
      {showRejectDialog && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[600px] p-8">
            <div className="flex items-center mb-4">
              <span className="material-icons text-red-500 text-4xl mr-3">cancel</span>
              <h3 className="text-2xl font-bold text-gray-800 dark:text-white">Reject Task</h3>
            </div>

            <p className="text-gray-600 dark:text-gray-300 mb-4 text-lg">
              Please provide a reason for rejecting this task. The student will receive your comment via email and in-app notification.
            </p>

            <textarea
              value={rejectComment}
              onChange={(e) => setRejectComment(e.target.value)}
              placeholder="Explain why the submission was rejected and what needs to be improved..."
              className="w-full h-32 p-4 rounded-xl border-2 border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none resize-none mb-6"
              autoFocus
            />

            <div className="flex justify-end space-x-3">
              <button
                onClick={handleRejectCancel}
                className="px-6 py-3 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded-lg transition-colors font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleRejectConfirm}
                disabled={!rejectComment.trim()}
                className="px-6 py-3 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Reject & Notify Student
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

