import React, { useState, useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { RoadLesson, RoadStudySet, RoadTask, StudySetKind } from '../types';
import { NodeStatus } from '../roadState';
import { apiUrl } from '../config';
import { LessonMaterials } from './LessonMaterials';

interface LessonModalProps {
  lesson: RoadLesson | null;
  taskStatus: (task: RoadTask) => NodeStatus;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
  onOpenTask: (task: RoadTask) => void;
  onOpenScript?: () => void; // admin: the teacher's Markdown script for this lesson
  studySetStatus: (set: RoadStudySet) => NodeStatus;
  onOpenStudySet: (set: RoadStudySet) => void;
  onAddStudySet?: (kind: StudySetKind) => void; // admin
  phaseLocked?: boolean; // student has not reached this lesson's phase (materials stay closed)
}

const isProbablyHtml = (value: string) => /<\s*[a-z][\s\S]*>/i.test(value);
const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const toHtml = (value: string) => {
  const v = (value || '').trim();
  if (!v) return '';
  if (isProbablyHtml(v)) return v;
  return `<p>${escapeHtml(v).replace(/\n/g, '<br>')}</p>`;
};

// View a lesson (summary + its tasks); admins can edit the title/summary with the rich-text
// editor or delete the lesson.
export const LessonModal: React.FC<LessonModalProps> = ({ lesson, taskStatus, isAdmin, onClose, onChanged, onOpenTask, onOpenScript, studySetStatus, onOpenStudySet, onAddStudySet, phaseLocked = false }) => {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({ HTMLAttributes: { class: 'max-w-full h-auto rounded-lg my-4' } }),
      Link.configure({ openOnClick: false }),
    ],
    content: '',
    editable: false,
    onUpdate: ({ editor }) => setDescription(editor.getHTML()),
  });

  useEffect(() => {
    setMode('view');
    if (lesson) {
      setTitle(lesson.title);
      const html = toHtml(lesson.description || '');
      setDescription(html);
      editor?.commands.setContent(html);
    }
  }, [lesson]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { editor?.setEditable(mode === 'edit'); }, [mode, editor]);

  if (!lesson) return null;

  const addImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e: any) => {
      const file = e.target.files[0];
      if (!file || !editor) return;
      const formData = new FormData();
      formData.append('image', file);
      try {
        const response = await fetch(apiUrl('/upload-image'), { method: 'POST', credentials: 'include', body: formData });
        if (response.ok) {
          const data = await response.json();
          editor.chain().focus().setImage({ src: data.url }).run();
        }
      } catch (err) {
        console.error('Image upload error:', err);
      }
    };
    input.click();
  };

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await fetch(apiUrl(`/lessons/${lesson.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: title.trim(), description })
      });
      onChanged();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await fetch(apiUrl(`/lessons/${lesson.id}`), { method: 'DELETE', credentials: 'include' });
      onChanged();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const toolbarButton = (active: boolean) =>
    `px-3 py-1 rounded ${active ? 'bg-primary text-white' : 'bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`;

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => !saving && onClose()}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[1100px] max-w-[95vw] max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-4">
          {mode === 'edit' ? (
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="flex-1 text-2xl font-bold p-2 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 focus:ring-2 focus:ring-primary outline-none"
              autoFocus
            />
          ) : (
            <h3 className="text-2xl font-bold text-gray-800 dark:text-white">{lesson.title}</h3>
          )}
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex-shrink-0">
            <span className="material-icons">close</span>
          </button>
        </div>

        <div className="flex-grow overflow-y-auto p-8 custom-scrollbar">
          {mode === 'delete' ? (
            <div className="flex flex-col items-center text-center py-8">
              <span className="material-icons text-red-500 text-5xl mb-3">warning</span>
              <h4 className="text-xl font-bold text-gray-800 dark:text-white mb-2">Delete this lesson?</h4>
              <p className="text-gray-600 dark:text-gray-300 max-w-md">All of its tasks, quizzes, flashcards and attached files — and every student submission and result on them — will be deleted. This cannot be undone.</p>
            </div>
          ) : mode === 'edit' ? (
            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Lesson Summary</label>
              {editor && (
                <div className="rounded-xl overflow-hidden border border-gray-200 dark:border-gray-600">
                  <div className="bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-2 flex flex-wrap gap-1">
                    <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} className={toolbarButton(editor.isActive('bold'))}><strong>B</strong></button>
                    <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} className={toolbarButton(editor.isActive('italic'))}><em>I</em></button>
                    <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={toolbarButton(editor.isActive('heading', { level: 2 }))}>H2</button>
                    <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} className={toolbarButton(editor.isActive('bulletList'))}>• List</button>
                    <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={toolbarButton(editor.isActive('orderedList'))}>1. List</button>
                    <button type="button" onClick={addImage} className="px-3 py-1 rounded bg-green-500 hover:bg-green-600 text-white flex items-center gap-1">
                      <span className="material-icons text-sm">image</span>Image
                    </button>
                  </div>
                  <EditorContent editor={editor} className="prose dark:prose-invert max-w-none p-4 min-h-[260px] focus:outline-none" />
                </div>
              )}
            </div>
          ) : (
            <>
              {lesson.description && (
                <div className="mb-8">
                  <h4 className="text-sm font-bold text-gray-500 mb-3">LESSON SUMMARY</h4>
                  {isProbablyHtml(lesson.description) ? (
                    <div className="prose dark:prose-invert max-w-none bg-gray-50 dark:bg-gray-900 p-4 rounded-lg" dangerouslySetInnerHTML={{ __html: lesson.description }} />
                  ) : (
                    <p className="text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap text-lg">{lesson.description}</p>
                  )}
                </div>
              )}

              <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
                <h4 className="text-sm font-bold text-gray-500 mb-4">
                  TASKS ({lesson.tasks.length})
                  {!isAdmin && lesson.tasks.length > 0 && lesson.tasks.every((t) => taskStatus(t) === 'locked') && (
                    <span className="ml-2 font-semibold normal-case text-gray-400">· not reached yet — the briefs open when you get here</span>
                  )}
                </h4>
                <div className="space-y-3">
                  {lesson.tasks.length === 0 && <p className="text-sm text-gray-400 italic">No tasks assigned yet.</p>}
                  {lesson.tasks.map((task) => {
                    const st = taskStatus(task);
                    const openable = isAdmin || st !== 'locked';
                    return (
                      <button
                        key={task.id}
                        type="button"
                        disabled={!openable}
                        onClick={() => onOpenTask(task)}
                        className={`w-full flex items-center justify-between p-4 rounded-xl text-left transition-colors ${
                          openable ? 'bg-gray-50 dark:bg-gray-700 hover:bg-primary/10 cursor-pointer' : 'bg-gray-50 dark:bg-gray-700 opacity-60 cursor-not-allowed'
                        }`}
                      >
                        <div className="flex items-center min-w-0">
                          {task.type === 'mandatory'
                            ? <span className="material-icons text-red-500 mr-2 text-sm">priority_high</span>
                            : <span className="material-icons text-yellow-500 mr-2 text-sm">stars</span>}
                          <span className="font-bold text-gray-800 dark:text-gray-200 truncate">{task.title}</span>
                          <span className="ml-3 text-xs text-gray-400 whitespace-nowrap">{task.xp_reward} ★{task.deadline ? ` · due ${new Date(task.deadline).toLocaleDateString()}` : ''}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                          {isAdmin && (task.unviewed_count || 0) > 0 && (
                            <span className="min-w-[20px] h-5 px-1.5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center">{task.unviewed_count}</span>
                          )}
                          {!isAdmin && st === 'completed' && <span className="material-icons text-green-500">check_circle</span>}
                          {!isAdmin && st === 'current' && <span className="material-icons text-primary-dark">flag</span>}
                          {!isAdmin && st === 'locked' && <span className="material-icons text-gray-400">lock</span>}
                          <span className="material-icons text-gray-400">chevron_right</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <LessonMaterials lessonId={lesson.id} files={lesson.files || []} isAdmin={isAdmin} locked={phaseLocked} onChanged={onChanged} />

              {(isAdmin || (lesson.study_sets || []).length > 0) && (
                <div className="border-t border-gray-200 dark:border-gray-700 pt-6 mt-6">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="text-sm font-bold text-gray-500">PRACTICE ({(lesson.study_sets || []).length})</h4>
                    {isAdmin && onAddStudySet && (
                      <div className="flex gap-2">
                        <button onClick={() => onAddStudySet('quiz')} className="px-3 py-1.5 rounded-lg text-sm font-bold bg-purple-50 text-purple-700 hover:bg-purple-100 dark:bg-purple-900/30 dark:text-purple-300 flex items-center gap-1">
                          <span className="material-icons text-base">quiz</span>Add quiz
                        </button>
                        <button onClick={() => onAddStudySet('flashcards')} className="px-3 py-1.5 rounded-lg text-sm font-bold bg-pink-50 text-pink-700 hover:bg-pink-100 dark:bg-pink-900/30 dark:text-pink-300 flex items-center gap-1">
                          <span className="material-icons text-base">style</span>Add flashcards
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="space-y-3">
                    {(lesson.study_sets || []).length === 0 && <p className="text-sm text-gray-400 italic">No quizzes or flashcards yet.</p>}
                    {(lesson.study_sets || []).map((set) => {
                      const st = studySetStatus(set);
                      const openable = isAdmin || st !== 'locked';
                      const quiz = set.kind === 'quiz';
                      return (
                        <button key={set.id} type="button" disabled={!openable} onClick={() => onOpenStudySet(set)}
                          className={`w-full flex items-center justify-between p-4 rounded-xl text-left transition-colors bg-gray-50 dark:bg-gray-700 ${openable ? 'hover:bg-primary/10 cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}>
                          <div className="flex items-center min-w-0">
                            <span className={`material-icons mr-2 text-base ${quiz ? 'text-purple-500' : 'text-pink-500'}`}>{quiz ? 'quiz' : 'style'}</span>
                            <span className="font-bold text-gray-800 dark:text-gray-200 truncate">{set.title}</span>
                            <span className="ml-3 text-xs text-gray-400 whitespace-nowrap">
                              {quiz ? 'Quiz' : 'Flashcards'} · {set.item_count} {quiz ? 'question' : 'card'}{set.item_count === 1 ? '' : 's'}
                              {!isAdmin && set.progress && set.progress.total === set.item_count ? ` · best ${set.progress.best_score}/${set.progress.total}` : ''}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                            {!isAdmin && st === 'completed' && <span className="material-icons text-green-500">check_circle</span>}
                            {!isAdmin && st === 'locked' && <span className="material-icons text-gray-400">lock</span>}
                            <span className="material-icons text-gray-400">{isAdmin ? 'edit' : 'chevron_right'}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-6 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between bg-white dark:bg-gray-800">
          {mode === 'delete' ? (
            <>
              <div />
              <div className="flex space-x-3">
                <button onClick={() => setMode('view')} disabled={saving} className="px-5 py-2.5 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">Cancel</button>
                <button onClick={remove} disabled={saving} className="px-5 py-2.5 bg-red-500 hover:bg-red-600 text-white font-bold rounded-lg shadow-md transition-all disabled:opacity-50">{saving ? 'Deleting…' : 'Delete'}</button>
              </div>
            </>
          ) : mode === 'edit' ? (
            <>
              <div />
              <div className="flex space-x-3">
                <button onClick={() => { setMode('view'); setTitle(lesson.title); editor?.commands.setContent(toHtml(lesson.description || '')); }} disabled={saving} className="px-5 py-2.5 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">Cancel</button>
                <button onClick={save} disabled={saving || !title.trim()} className="px-5 py-2.5 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg shadow-md transition-all disabled:opacity-50">{saving ? 'Saving…' : 'Save Changes'}</button>
              </div>
            </>
          ) : (
            <>
              {isAdmin ? (
                <div className="flex space-x-2">
                  <button onClick={() => setMode('edit')} className="px-5 py-2.5 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg transition-colors flex items-center">
                    <span className="material-icons text-sm mr-1">edit</span>Edit
                  </button>
                  <button onClick={() => setMode('delete')} className="px-5 py-2.5 bg-red-500 hover:bg-red-600 text-white font-bold rounded-lg transition-colors flex items-center">
                    <span className="material-icons text-sm mr-1">delete</span>Delete
                  </button>
                  {onOpenScript && (
                    <button onClick={onOpenScript} title="Your Markdown notes for teaching this lesson (students never see them)" className="px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-lg transition-colors flex items-center">
                      <span className="material-icons text-sm mr-1">description</span>Lesson script
                    </button>
                  )}
                </div>
              ) : <div />}
              <button onClick={onClose} className="px-6 py-2.5 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 font-bold rounded-lg transition-colors">Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
