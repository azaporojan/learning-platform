import React, { useState, useEffect, useRef } from 'react';
import { Path } from '../types';
import { useSocket } from '../contexts/SocketContext';
import { TaskModal } from './TaskModal';
import { apiUrl } from '../config';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';

interface Task {
  id: number;
  title: string;
  type: 'mandatory' | 'optional';
  completed: boolean;
  xp_reward: number;
  unviewed_count?: number;
  is_new?: boolean;
  deadline?: string;
  description?: string;
  position_x: number;
  position_y: number;
  order_index: number;
}

interface Lesson {
  id: number;
  title: string;
  description?: string;
  position_x: number;
  position_y: number;
  completed: boolean;
  parent_id: number | null;
  order_index: number; // Used for alternating UP/DOWN layout
  tasks: Task[];
}

interface PathDetailsProps {
  path: Path;
  onBack: () => void;
  currentUser: any;
}

export const PathDetails: React.FC<PathDetailsProps> = ({ path, onBack, currentUser }) => {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [isAdmin] = useState(currentUser?.role === 'admin');
  const graphScrollRef = useRef<HTMLDivElement | null>(null);
  const { socket } = useSocket();
  const [canvasWidth, setCanvasWidth] = useState(3000); // Dynamic canvas width

  // Modals state
  const [addLessonModal, setAddLessonModal] = useState<{ open: boolean, parentId: number | null, x: number, y: number }>({ open: false, parentId: null, x: 0, y: 0 });
  const [addTaskModal, setAddTaskModal] = useState<{ open: boolean, lessonId: number | null, x: number, y: number, order: number, isSubmitting?: boolean }>({ open: false, lessonId: null, x: 0, y: 0, order: 1, isSubmitting: false });
  const [viewLessonModal, setViewLessonModal] = useState<{ open: boolean, lesson: Lesson | null }>({ open: false, lesson: null });
  const [editLessonModal, setEditLessonModal] = useState<{ open: boolean, lesson: Lesson | null }>({ open: false, lesson: null });
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{ open: boolean, lessonId: number | null }>({ open: false, lessonId: null });
  const [viewTaskModal, setViewTaskModal] = useState<{ open: boolean, task: Task | null }>({ open: false, task: null });
  const [taskType, setTaskType] = useState<'mandatory' | 'optional'>('mandatory');

  // Lesson editor state (rich summary)
  const [editLessonData, setEditLessonData] = useState<{ title: string; description: string }>({ title: '', description: '' });

  const isProbablyHtml = (value: string) => /<\s*[a-z][\s\S]*>/i.test(value);
  const escapeHtml = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

  const normalizeLessonDescriptionToHtml = (value: string) => {
    const v = (value || '').trim();
    if (!v) return '';
    if (isProbablyHtml(v)) return v;
    return `<p>${escapeHtml(v).replace(/\n/g, '<br>')}</p>`;
  };

  // Initialize TipTap editor for lesson summary (same style as task editor)
  const lessonEditor = useEditor({
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
    content: editLessonData.description || '',
    editable: editLessonModal.open,
    onUpdate: ({ editor }) => {
      setEditLessonData((prev) => ({ ...prev, description: editor.getHTML() }));
    },
  });

  // Sync editor content when opening edit modal / switching lesson
  useEffect(() => {
    if (!editLessonModal.open || !editLessonModal.lesson) return;
    const next = {
      title: editLessonModal.lesson.title,
      description: normalizeLessonDescriptionToHtml(editLessonModal.lesson.description || ''),
    };
    setEditLessonData(next);
    if (lessonEditor) {
      lessonEditor.commands.setContent(next.description || '');
      lessonEditor.setEditable(true);
    }
  }, [editLessonModal.open, editLessonModal.lesson, lessonEditor]);

  useEffect(() => {
    if (lessonEditor) {
      lessonEditor.setEditable(!!editLessonModal.open);
    }
  }, [editLessonModal.open, lessonEditor]);

  // Handle image upload for lesson editor
  const addLessonImage = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e: any) => {
      const file = e.target.files[0];
      if (file && lessonEditor) {
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
            lessonEditor.chain().focus().setImage({ src: data.url }).run();
          } else {
            console.error('Failed to upload image');
          }
        } catch (error) {
          console.error('Image upload error:', error);
        }
      }
    };
    input.click();
  };

  // Fetch Lessons
  const fetchLessons = async () => {
    try {
      const res = await fetch(apiUrl(`/paths/${path.id}/details?t=${Date.now()}`), { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        // Ensure tasks are sorted by order
        const sortedLessons = data.map((l: Lesson) => ({
          ...l,
          tasks: l.tasks ? l.tasks.sort((a, b) => a.order_index - b.order_index) : []
        }));
        setLessons(sortedLessons);
        
        // Calculate dynamic canvas width based on rightmost element
        calculateCanvasWidth(sortedLessons);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Calculate canvas width dynamically based on the rightmost element position
  const calculateCanvasWidth = (lessonsData: Lesson[]) => {
    if (lessonsData.length === 0) {
      setCanvasWidth(1500); // Empty path
      return;
    }
    
    let maxX = 0;
    
    // Check all lessons
    lessonsData.forEach(lesson => {
      const lessonRightEdge = lesson.position_x + 64; // lesson width (w-16 = 64px)
      if (lessonRightEdge > maxX) maxX = lessonRightEdge;
      
      // Check all tasks in this lesson
      lesson.tasks.forEach(task => {
        const taskRightEdge = task.position_x + 48 + 16; // task width (w-12 = 48px) + offset (8px * 2)
        if (taskRightEdge > maxX) maxX = taskRightEdge;
      });
    });
    
    // Add padding: left padding (80px) + right padding for ghost nodes (250px)
    setCanvasWidth(maxX + 330);
  };

  useEffect(() => {
    fetchLessons();
  }, [path.id]);

  // Socket.IO listeners for live task updates
  useEffect(() => {
    if (!socket) return;

    const handleTaskCompleted = (data: { userId: number, taskId: number }) => {
      if (!currentUser) return;
      if (data.userId === currentUser.id) {
        fetchLessons();
      }
    };

    const handleTaskChange = () => {
      fetchLessons();
    };

    const handleTaskViewed = (data: { taskId: number, userId: number }) => {
      if (currentUser && data.userId === currentUser.id) {
        fetchLessons();
      }
    };

    socket.on('task:completed', handleTaskCompleted);
    socket.on('task:created', handleTaskChange);
    socket.on('task:updated', handleTaskChange);
    socket.on('task:deleted', handleTaskChange);
    socket.on('task:submission_uploaded', handleTaskChange);
    socket.on('task:viewed', handleTaskViewed);
    socket.on('lesson:created', handleTaskChange); // Refresh when lessons are created
    socket.on('lesson:updated', handleTaskChange); // Refresh when lessons are renamed or moved
    socket.on('lesson:deleted', handleTaskChange); // Refresh when lessons are deleted


    return () => {
      socket.off('task:completed', handleTaskCompleted);
      socket.off('task:created', handleTaskChange);
      socket.off('task:updated', handleTaskChange);
      socket.off('task:deleted', handleTaskChange);
      socket.off('task:submission_uploaded', handleTaskChange);
      socket.off('task:viewed', handleTaskViewed);
      socket.off('lesson:created', handleTaskChange);
      socket.off('lesson:updated', handleTaskChange);
      socket.off('lesson:deleted', handleTaskChange);
    };
  }, [socket, currentUser]);

  // Helper function: Check if all mandatory tasks in a lesson are completed
  const areAllMandatoryTasksCompleted = (lesson: Lesson): boolean => {
    const mandatoryTasks = lesson.tasks.filter(t => t.type === 'mandatory');
    if (mandatoryTasks.length === 0) return true; // If no mandatory tasks, consider it completed
    return mandatoryTasks.every(t => t.completed);
  };

  // Handlers
  const handleAddLesson = async (title: string, description: string) => {
    const { parentId, x, y } = addLessonModal;
    const order = lessons.length + 1;

    await fetch(apiUrl('/lessons'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pathId: path.id, title, description, x, y, order, parentId })
    });
    setAddLessonModal({ ...addLessonModal, open: false });
    fetchLessons();
  };

  // Calculate center Y position for initial node
  const getCenterY = () => {
    // Approximate center of visible area (accounting for header and padding)
    return 250; // Fixed center for consistency
  };

  const handleAddTask = async (title: string, type: 'mandatory' | 'optional', xp: number, deadline: string) => {
    if (!addTaskModal.lessonId) return;
    setAddTaskModal({ ...addTaskModal, isSubmitting: true });

    const { x, y, order } = addTaskModal;

    try {
      await fetch(apiUrl('/tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lessonId: addTaskModal.lessonId, title, type, xp, deadline, x, y, order })
      });
      setAddTaskModal({ ...addTaskModal, open: false, isSubmitting: false });
      setTaskType('mandatory'); // Reset to default
      fetchLessons();
    } catch (err) {
      console.error(err);
      setAddTaskModal({ ...addTaskModal, isSubmitting: false });
    }
  };

  const handleEditLesson = async (title: string, description: string) => {
    if (!editLessonModal.lesson) return;

    await fetch(apiUrl(`/lessons/${editLessonModal.lesson.id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description })
    });
    setEditLessonModal({ open: false, lesson: null });
    setViewLessonModal({ open: false, lesson: null });
    fetchLessons();
  };

  const handleDeleteLesson = async () => {
    if (!deleteConfirmModal.lessonId) return;

    await fetch(apiUrl(`/lessons/${deleteConfirmModal.lessonId}`), {
      method: 'DELETE'
    });
    setDeleteConfirmModal({ open: false, lessonId: null });
    setViewLessonModal({ open: false, lesson: null });
    fetchLessons();
  };

  // --- Rendering Logic ---

  // Helper to calculate potential new node positions
  const getPotentialNodes = (parent: Lesson) => {
    const spacingX = 250;

    // Check existing children (Next Lesson)
    const children = lessons.filter(l => l.parent_id === parent.id);
    const hasNextLesson = children.some(c => Math.abs(c.position_y - parent.position_y) < 10);

    const potentials = [];

    // 1. Next Lesson (Always Straight)
    if (!hasNextLesson) {
      potentials.push({ type: 'lesson', x: parent.position_x + spacingX, y: parent.position_y });
    }

    // 2. Next Task (Chain Logic)
    // Determine direction based on Lesson Order Index (Odd = UP, Even = DOWN)
    // Assuming first lesson is index 1 -> UP
    const isUpDirection = parent.order_index % 2 !== 0;
    const directionMultiplier = isUpDirection ? -1 : 1;
    const taskSpacingY = 120; // Vertical gap from lesson to first task
    const taskSpacingX = 150; // Horizontal gap between tasks

    // Find the last task in the chain
    const lastTask = parent.tasks[parent.tasks.length - 1];

    let nextTaskX, nextTaskY, nextOrder;

    if (!lastTask) {
      // First task connects to Lesson DIAGONALLY (45 degrees)
      // For 45 degrees: dx = dy
      nextTaskX = parent.position_x + taskSpacingY; // Move right by same amount as up/down
      nextTaskY = parent.position_y + (taskSpacingY * directionMultiplier);
      nextOrder = 1;
    } else {
      // Subsequent tasks connect to Last Task HORIZONTALLY (To the Right)
      nextTaskX = lastTask.position_x + taskSpacingX;
      nextTaskY = lastTask.position_y; // Keep same Y level
      nextOrder = lastTask.order_index + 1;
    }

    potentials.push({
      type: 'task',
      x: nextTaskX,
      y: nextTaskY,
      order: nextOrder
    });

    return potentials;
  };

  // Allow mouse-wheel vertical scrolling to move the graph horizontally (like Google Classroom / diagrams).
  useEffect(() => {
    const el = graphScrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // Trackpads often send deltaX; don't interfere with that.
      const mostlyVertical = Math.abs(e.deltaY) > Math.abs(e.deltaX);
      if (!mostlyVertical) return;

      // If there's no horizontal overflow, do nothing.
      if (el.scrollWidth <= el.clientWidth) return;

      // Turn vertical wheel into horizontal scroll.
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel as EventListener);
  }, []);

  return (
    <div className="h-full flex flex-col bg-white dark:bg-gray-900 rounded-3xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden relative">
      {/* Header */}
      <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between bg-white dark:bg-gray-900 z-10 shadow-sm">
        <div className="flex items-center">
          <button onClick={onBack} className="mr-4 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <span className="material-icons">arrow_back</span>
          </button>
          <h2 className="text-2xl font-extrabold italic text-gray-800 dark:text-white">{path.title} Path</h2>
        </div>
      </div>

      {/* Graph Area */}
      <div ref={graphScrollRef} className="flex-grow overflow-x-auto overflow-y-hidden custom-scrollbar bg-white dark:bg-gray-950">
        <div style={{ minWidth: `${canvasWidth}px` }} className="h-full flex flex-col">
          <div className="flex-grow bg-transparent pointer-events-none"></div>

          <div className="h-[500px] relative px-20 flex-shrink-0 -mt-24">

            {/* SVG Layer */}
            <svg className="absolute top-0 left-0 w-full h-full pointer-events-none z-0">

              {/* 1. Lesson Connections (Main Line) */}
              {lessons.map(lesson => {
                if (!lesson.parent_id) return null;
                const parent = lessons.find(l => l.id === lesson.parent_id);
                if (!parent) return null;

                return (
                  <line
                    key={`conn-lesson-${lesson.id}`}
                    x1={parent.position_x + 32}
                    y1={parent.position_y + 32}
                    x2={lesson.position_x + 32}
                    y2={lesson.position_y + 32}
                    stroke="#10b981"
                    strokeWidth="3"
                  />
                );
              })}

              {/* 2. Task Connections (Chain: Lesson -> Task1 -> Task2 ...) */}
              {lessons.map((lesson, lessonIndex) => {
                // Check if this lesson is locked for students
                const isLessonLocked = lessonIndex > 0 ? !areAllMandatoryTasksCompleted(lessons[lessonIndex - 1]) : false;
                
                // For students: Don't show task connections from locked lessons
                if (!isAdmin && isLessonLocked) {
                  return null;
                }

                return lesson.tasks.map((task, index) => {
                  // Start point: Previous task OR Lesson if it's the first task
                  // Adjust offsets based on node size difference
                  const prevNode = index === 0 ? lesson : lesson.tasks[index - 1];
                  const prevSizeOffset = index === 0 ? 32 : 8 + 24; // Lesson=32, Task=32 (Wait, Task is smaller now)
                  // Lesson center: +32 (w-16)
                  // Task center: +24 (w-12)

                  const x1 = prevNode.position_x + (index === 0 ? 32 : 24 + 8);
                  const y1 = prevNode.position_y + (index === 0 ? 32 : 24 + 8);
                  const x2 = task.position_x + 24 + 8;
                  const y2 = task.position_y + 24 + 8;

                  return (
                    <line
                      key={`conn-task-${task.id}`}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke="black"
                      strokeWidth="2"
                      strokeDasharray="6,4"
                    />
                  );
                });
              })}

              {/* 3. Ghost Connections (Dotted) */}
              {isAdmin && lessons.map(parent => {
                const potentials = getPotentialNodes(parent);
                return potentials.map((p, idx) => {
                  // Source point for ghost line
                  let sourceX, sourceY;
                  if (p.type === 'lesson') {
                    sourceX = parent.position_x + 32;
                    sourceY = parent.position_y + 32;
                  } else {
                    // Connect to last task or lesson
                    const lastTask = parent.tasks[parent.tasks.length - 1];
                    if (!lastTask) {
                      sourceX = parent.position_x + 32;
                      sourceY = parent.position_y + 32;
                    } else {
                      sourceX = lastTask.position_x + 24 + 8;
                      sourceY = lastTask.position_y + 24 + 8;
                    }
                  }

                  const targetOffset = p.type === 'lesson' ? 32 : 24 + 8;

                  return (
                    <line
                      key={`ghost-line-${parent.id}-${idx}`}
                      x1={sourceX}
                      y1={sourceY}
                      x2={p.x + targetOffset}
                      y2={p.y + targetOffset}
                      stroke="black"
                      strokeWidth="2"
                      strokeDasharray="6,4"
                      opacity="0.3"
                    />
                  );
                });
              })}
            </svg>

            {/* 4. Ghost Nodes (Plus Buttons) */}
            {isAdmin && lessons.map(parent => {
              const potentials = getPotentialNodes(parent);
              return potentials.map((p, idx) => {
                const isTask = p.type !== 'lesson';
                const sizeClass = isTask ? 'w-12 h-12' : 'w-16 h-16';
                const iconSize = isTask ? 'text-xl' : 'text-2xl';
                const labelTopClass = isTask ? 'top-14' : 'top-20'; // Task-uri mai mici = label mai sus

                return (
                  <div
                    key={`ghost-node-${parent.id}-${idx}`}
                    className="absolute group cursor-pointer z-10"
                    style={{ left: `${p.x + (isTask ? 8 : 0)}px`, top: `${p.y + (isTask ? 8 : 0)}px` }}
                    onClick={() => {
                      if (p.type === 'lesson') {
                        setAddLessonModal({ open: true, parentId: parent.id, x: p.x, y: p.y });
                      } else {
                        setTaskType('mandatory'); // Reset to default
                        setAddTaskModal({ open: true, lessonId: parent.id, x: p.x, y: p.y, order: p.order || 1 });
                      }
                    }}
                  >
                    <div className={`${sizeClass} rounded-full bg-gradient-to-br from-green-50 to-green-100 border-2 border-green-400 flex items-center justify-center hover:from-green-100 hover:to-green-200 hover:border-green-500 hover:scale-110 transition-all shadow-md hover:shadow-lg`}>
                      <span className={`material-icons text-green-600 font-bold ${iconSize}`}>add</span>
                    </div>
                    <div className={`absolute ${labelTopClass} left-1/2 transform -translate-x-1/2 whitespace-nowrap text-xs font-bold text-green-600 bg-white px-2 py-1 rounded shadow-sm border border-green-200 opacity-0 group-hover:opacity-100 transition-opacity`}>
                      {p.type === 'lesson' ? 'Next Lesson' : 'Next Task'}
                    </div>
                  </div>
                );
              });
            })}

            {/* 5. Start Node Button (If empty) */}
            {lessons.length === 0 && isAdmin && (
              <div
                className="absolute left-20 group cursor-pointer z-20"
                style={{ top: `${getCenterY()}px` }}
                onClick={() => setAddLessonModal({ open: true, parentId: null, x: 80, y: getCenterY() })}
              >
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-green-400 to-green-500 border-4 border-green-600 flex items-center justify-center shadow-xl hover:scale-110 hover:shadow-2xl transition-all">
                  <span className="material-icons text-white font-bold text-4xl">add</span>
                </div>
                <div className="absolute top-24 left-1/2 transform -translate-x-1/2 font-bold text-green-600 bg-white px-3 py-1 rounded-lg shadow-md border border-green-200 whitespace-nowrap">Start Path</div>
              </div>
            )}

            {/* 6. Render LESSON Nodes (Main Line) */}
            {lessons.map((lesson, lessonIndex) => {
              // Check if this lesson is locked
              // A lesson is locked if ANY previous lesson has incomplete mandatory tasks
              const isLocked = (() => {
                if (lessonIndex === 0) return false; // First lesson is always unlocked
                
                // Check all previous lessons - if ANY has incomplete mandatory tasks, this is locked
                for (let i = 0; i < lessonIndex; i++) {
                  if (!areAllMandatoryTasksCompleted(lessons[i])) {
                    return true; // Locked because a previous lesson is not completed
                  }
                }
                return false; // All previous lessons completed
              })();

              let bgClass = '';
              let textClass = '';
              let borderClass = '';

              if (lesson.completed) {
                bgClass = 'bg-gradient-to-br from-green-400 to-green-500';
                textClass = 'text-white';
                borderClass = 'border-2 border-green-600';
              } else if (!isLocked) {
                bgClass = 'bg-primary';
                textClass = 'text-white';
                borderClass = 'border-2 border-primary';
              } else {
                bgClass = 'bg-gradient-to-br from-gray-200 to-gray-300';
                textClass = 'text-gray-500';
                borderClass = 'border-2 border-gray-400';
              }

              return (
                <div
                  key={`lesson-${lesson.id}`}
                  className="absolute group z-30"
                  style={{ left: `${lesson.position_x}px`, top: `${lesson.position_y}px` }}
                  onClick={() => {
                    // Students cannot open locked lessons
                    if (!isAdmin && isLocked) {
                      return; // Do nothing if locked
                    }
                    setViewLessonModal({ open: true, lesson });
                  }}
                >
                  <div
                    className={`w-16 h-16 rounded-full flex items-center justify-center shadow-lg transition-all relative
                      ${bgClass} ${borderClass}
                      ${isLocked && !isAdmin ? 'cursor-not-allowed opacity-75' : 'hover:scale-110 hover:shadow-xl cursor-pointer'}
                    `}
                  >
                    {isLocked && !isAdmin ? (
                      <span className="material-icons text-gray-400 text-2xl">lock</span>
                    ) : (
                      <span className={`font-extrabold text-xl ${textClass}`}>{lesson.order_index}</span>
                    )}
                  </div>
                  <div className="absolute top-20 left-1/2 transform -translate-x-1/2 whitespace-nowrap font-bold text-gray-800 dark:text-gray-200 text-base bg-white dark:bg-gray-800 px-3 py-1 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
                    {lesson.title}
                  </div>
                </div>
              );
            })}

            {/* 7. Render TASK Nodes (Chains) */}
            {lessons.map((lesson, lessonIndex) => (
              lesson.tasks.map((task, taskIndex) => {
                // Check if task is locked
                const isLocked = (() => {
                  // First check if ANY previous lesson has incomplete mandatory tasks
                  for (let i = 0; i < lessonIndex; i++) {
                    if (!areAllMandatoryTasksCompleted(lessons[i])) {
                      return true; // Locked because a previous lesson is not completed
                    }
                  }
                  
                  // Then check within current lesson
                  if (taskIndex === 0) {
                    return false; // First task of this lesson is unlocked (if we got here)
                  } else {
                    // Subsequent tasks: locked if previous task is not completed
                    const prevTask = lesson.tasks[taskIndex - 1];
                    return !prevTask.completed;
                  }
                })();

                return (
                  <div
                    key={`task-${task.id}`}
                    className="absolute group z-20"
                    style={{ left: `${task.position_x + 8}px`, top: `${task.position_y + 8}px` }}
                    onClick={() => {
                      if (!isLocked || isAdmin) {
                        setViewTaskModal({ open: true, task: task });
                      }
                    }}
                  >
                    <div
                      className={`w-12 h-12 rounded-full flex items-center justify-center shadow-md border-2 transition-transform ${isLocked && !isAdmin ? 'cursor-not-allowed opacity-60' : 'hover:scale-105 cursor-pointer'
                        } relative ${task.completed
                          ? 'bg-green-50 border-green-400'
                          : isLocked && !isAdmin
                            ? 'bg-gray-100 border-gray-300'
                            : task.type === 'mandatory'
                              ? 'bg-blue-50 border-blue-400'
                              : 'bg-gradient-to-br from-yellow-100 to-yellow-100 border-yellow-300'
                        }`}
                    >
                      {/* Admin Badge: Red bouncing badge with submission count */}
                      {isAdmin && (task.unviewed_count || 0) > 0 && (
                        <div className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center border-2 border-white shadow-md z-50 animate-bounce">
                          {task.unviewed_count}
                        </div>
                      )}

                      {/* Student Badge: Blue "NEW" badge for unviewed tasks */}
                      {!isAdmin && task.is_new && !task.completed && (
                        <div className="absolute -top-2 -right-2 w-6 h-6 bg-gradient-to-br from-blue-500 to-blue-600 text-white text-[8px] font-bold rounded-full flex items-center justify-center border-2 border-white shadow-lg z-50 animate-pulse">
                          NEW
                        </div>
                      )}

                      {isLocked && !isAdmin && !task.completed && (
                        <span className="material-icons text-gray-400 text-lg">lock</span>
                      )}
                      {(!isLocked || isAdmin) && !task.completed && task.type === 'mandatory' && (
                        <span className="material-icons text-blue-500 text-lg">assignment</span>
                      )}
                      {(!isLocked || isAdmin) && !task.completed && task.type === 'optional' && (
                        <span className="material-icons text-yellow-400 text-xl">stars</span>
                      )}
                      {task.completed && (
                        <span className="material-icons text-green-500 text-2xl">check_circle</span>
                      )}
                    </div>

                    <div className="absolute top-14 left-1/2 transform -translate-x-1/2 whitespace-nowrap bg-white border border-gray-200 px-2 py-1 rounded text-xs text-gray-600 shadow-sm flex items-center">
                      {task.title}
                      {isLocked && !isAdmin && !task.completed && (
                        <span className="material-icons text-xs ml-1 text-gray-400">lock</span>
                      )}
                    </div>
                  </div>
                );
              })
            ))}

          </div>

          <div className="flex-grow bg-transparent pointer-events-none"></div>
        </div>
      </div>

      {/* Add Lesson Modal */}
      {addLessonModal.open && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-xl w-96">
            <h3 className="text-xl font-bold mb-4">New Lesson</h3>
            <form onSubmit={(e) => {
              e.preventDefault();
              const form = e.target as any;
              handleAddLesson(form.title.value, form.description.value);
            }}>
              <div className="mb-4">
                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Lesson Title</label>
                <input name="title" placeholder="e.g., Introduction to HTML" className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 focus:ring-2 focus:ring-primary outline-none" required autoFocus />
              </div>
              <div className="mb-6">
                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Lesson Summary</label>
                <textarea name="description" placeholder="What will students learn in this lesson?" rows={4} className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 focus:ring-2 focus:ring-primary outline-none resize-none"></textarea>
              </div>
              <div className="flex justify-end space-x-3">
                <button type="button" onClick={() => setAddLessonModal({ ...addLessonModal, open: false })} className="px-5 py-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">Cancel</button>
                <button type="submit" className="px-5 py-2 bg-primary text-white font-bold rounded-lg shadow-md hover:shadow-lg transition-all">Create</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Task Modal */}
      {addTaskModal.open && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-xl w-96">
            <h3 className="text-xl font-bold mb-4">Add Task</h3>
            <form onSubmit={(e) => {
              e.preventDefault();
              const form = e.target as any;
              const deadlineValue = form.deadline.value || null; // Convert empty string to null
              handleAddTask(
                form.title.value,
                form.type.value,
                parseInt(form.xp.value),
                deadlineValue
              );
            }}>
              <input name="title" placeholder="Task Title" className="w-full mb-4 p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 outline-none focus:ring-2 focus:ring-primary" required autoFocus />

              <div className="mb-4">
                <label className="block text-xs font-bold text-gray-500 mb-1">Type</label>
                <select
                  name="type"
                  className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 outline-none"
                  onChange={(e) => setTaskType(e.target.value as 'mandatory' | 'optional')}
                  value={taskType}
                >
                  <option value="mandatory">Mandatory (Blocker)</option>
                  <option value="optional">Optional (Bonus XP)</option>
                </select>
              </div>

              <div className="flex space-x-4 mb-6">
                <div className="w-1/2">
                  <label className="block text-xs font-bold text-gray-500 mb-1">XP Reward</label>
                  <input type="number" name="xp" defaultValue="10" className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 outline-none" />
                </div>
                <div className="w-1/2">
                  <label className="block text-xs font-bold text-gray-500 mb-1">
                    Deadline {taskType === 'optional' && <span className="text-gray-400 font-normal">(Optional)</span>}
                  </label>
                  <input
                    type="date"
                    name="deadline"
                    className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 outline-none"
                    required={taskType === 'mandatory'}
                  />
                </div>
              </div>

              <div className="flex justify-end space-x-3">
                <button type="button" onClick={() => { setAddTaskModal({ ...addTaskModal, open: false }); setTaskType('mandatory'); }} className="px-5 py-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors" disabled={addTaskModal.isSubmitting}>Cancel</button>
                <button type="submit" className="px-5 py-2 bg-primary text-white font-bold rounded-lg shadow-md hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed" disabled={addTaskModal.isSubmitting}>
                  {addTaskModal.isSubmitting ? 'Adding...' : 'Add Task'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* View Lesson Modal */}
      {viewLessonModal.open && viewLessonModal.lesson && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setViewLessonModal({ open: false, lesson: null })}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[1100px] max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <h3 className="text-2xl font-bold text-gray-800 dark:text-white">{viewLessonModal.lesson.title}</h3>
              <button onClick={() => setViewLessonModal({ open: false, lesson: null })} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                <span className="material-icons">close</span>
              </button>
            </div>

            {/* Body */}
            <div className="flex-grow overflow-y-auto p-8 custom-scrollbar">
              {viewLessonModal.lesson.description && (
                <div className="mb-8">
                  <h4 className="text-sm font-bold text-gray-500 mb-3">LESSON SUMMARY</h4>
                  {isProbablyHtml(viewLessonModal.lesson.description) ? (
                    <div
                      className="prose dark:prose-invert max-w-none bg-gray-50 dark:bg-gray-900 p-4 rounded-lg"
                      dangerouslySetInnerHTML={{ __html: viewLessonModal.lesson.description }}
                    />
                  ) : (
                    <p className="text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap text-lg">
                      {viewLessonModal.lesson.description}
                    </p>
                  )}
                </div>
              )}

              <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
                <h4 className="text-sm font-bold text-gray-500 mb-4">TASKS ({viewLessonModal.lesson.tasks.length})</h4>
                <div className="space-y-3">
                  {viewLessonModal.lesson.tasks.length === 0 && (
                    <p className="text-sm text-gray-400 italic">No tasks assigned yet.</p>
                  )}
                  {viewLessonModal.lesson.tasks.map(task => (
                    <div key={task.id} className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-700 rounded-xl">
                      <div className="flex items-center">
                        {task.type === 'mandatory' && <span className="material-icons text-red-500 mr-2 text-sm">priority_high</span>}
                        <span className="font-bold text-gray-800 dark:text-gray-200">{task.title}</span>
                      </div>
                      {task.completed && <span className="material-icons text-green-500">check_circle</span>}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between bg-white dark:bg-gray-800">
              {isAdmin ? (
                <div className="flex space-x-2">
                  <button
                    onClick={() => {
                      setEditLessonModal({ open: true, lesson: viewLessonModal.lesson });
                      setViewLessonModal({ open: false, lesson: null });
                    }}
                    className="px-5 py-2.5 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg transition-colors flex items-center"
                  >
                    <span className="material-icons text-sm mr-1">edit</span>
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      setDeleteConfirmModal({ open: true, lessonId: viewLessonModal.lesson?.id || null });
                    }}
                    className="px-5 py-2.5 bg-red-500 hover:bg-red-600 text-white font-bold rounded-lg transition-colors flex items-center"
                  >
                    <span className="material-icons text-sm mr-1">delete</span>
                    Delete
                  </button>
                </div>
              ) : (
                <div></div>
              )}
              <button onClick={() => setViewLessonModal({ open: false, lesson: null })} className="px-6 py-2.5 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 font-bold rounded-lg transition-colors">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Lesson Modal */}
      {editLessonModal.open && editLessonModal.lesson && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[1100px] max-h-[90vh] overflow-hidden flex flex-col">
            {/* Header */}
            <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <h3 className="text-2xl font-bold text-gray-800 dark:text-white">Edit Lesson</h3>
              <button onClick={() => setEditLessonModal({ open: false, lesson: null })} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                <span className="material-icons">close</span>
              </button>
            </div>

            {/* Body */}
            <div className="flex-grow overflow-y-auto p-8 custom-scrollbar">
              <div className="mb-6">
                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Lesson Title</label>
                <input
                  value={editLessonData.title}
                  onChange={(e) => setEditLessonData((prev) => ({ ...prev, title: e.target.value }))}
                  className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 focus:ring-2 focus:ring-primary outline-none"
                  required
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Lesson Summary</label>
                {lessonEditor && (
                  <div className="rounded-xl overflow-hidden border border-gray-200 dark:border-gray-600">
                    {/* Toolbar */}
                    <div className="bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-2 flex flex-wrap gap-1">
                      <button
                        onClick={() => lessonEditor.chain().focus().toggleBold().run()}
                        className={`px-3 py-1 rounded ${lessonEditor.isActive('bold') ? 'bg-primary text-white' : 'bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                        type="button"
                      >
                        <strong>B</strong>
                      </button>
                      <button
                        onClick={() => lessonEditor.chain().focus().toggleItalic().run()}
                        className={`px-3 py-1 rounded ${lessonEditor.isActive('italic') ? 'bg-primary text-white' : 'bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                        type="button"
                      >
                        <em>I</em>
                      </button>
                      <button
                        onClick={() => lessonEditor.chain().focus().toggleHeading({ level: 2 }).run()}
                        className={`px-3 py-1 rounded ${lessonEditor.isActive('heading', { level: 2 }) ? 'bg-primary text-white' : 'bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                        type="button"
                      >
                        H2
                      </button>
                      <button
                        onClick={() => lessonEditor.chain().focus().toggleBulletList().run()}
                        className={`px-3 py-1 rounded ${lessonEditor.isActive('bulletList') ? 'bg-primary text-white' : 'bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                        type="button"
                      >
                        • List
                      </button>
                      <button
                        onClick={() => lessonEditor.chain().focus().toggleOrderedList().run()}
                        className={`px-3 py-1 rounded ${lessonEditor.isActive('orderedList') ? 'bg-primary text-white' : 'bg-white dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                        type="button"
                      >
                        1. List
                      </button>
                      <button
                        onClick={addLessonImage}
                        className="px-3 py-1 rounded bg-green-500 hover:bg-green-600 text-white flex items-center gap-1"
                        type="button"
                      >
                        <span className="material-icons text-sm">image</span>
                        Image
                      </button>
                    </div>

                    {/* Editor Content */}
                    <EditorContent
                      editor={lessonEditor}
                      className="prose dark:prose-invert max-w-none p-4 min-h-[260px] focus:outline-none"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-gray-200 dark:border-gray-700 flex justify-end space-x-3 bg-white dark:bg-gray-800">
              <button type="button" onClick={() => setEditLessonModal({ open: false, lesson: null })} className="px-6 py-2.5 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleEditLesson(editLessonData.title, editLessonData.description)}
                className="px-6 py-2.5 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg shadow-md hover:shadow-lg transition-all"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmModal.open && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-xl w-96">
            <div className="flex items-center mb-4">
              <span className="material-icons text-red-500 text-3xl mr-3">warning</span>
              <h3 className="text-xl font-bold text-gray-800 dark:text-white">Delete Lesson?</h3>
            </div>
            <p className="text-gray-600 dark:text-gray-300 mb-6">
              Are you sure you want to delete this lesson? All associated tasks will also be deleted. This action cannot be undone.
            </p>
            <div className="flex justify-end space-x-3">
              <button onClick={() => setDeleteConfirmModal({ open: false, lessonId: null })} className="px-5 py-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">
                Cancel
              </button>
              <button onClick={handleDeleteLesson} className="px-5 py-2 bg-red-500 hover:bg-red-600 text-white font-bold rounded-lg shadow-md hover:shadow-lg transition-all">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Modal */}
      {viewTaskModal.open && viewTaskModal.task && (
        <TaskModal
          task={viewTaskModal.task}
          isOpen={viewTaskModal.open}
          onClose={() => {
            setViewTaskModal({ open: false, task: null });
            fetchLessons();
          }}
          isAdmin={isAdmin}
          currentUserId={currentUser?.id || 0}
          currentUser={currentUser}
          onUpdate={fetchLessons}
        />
      )}

    </div>
  );
};