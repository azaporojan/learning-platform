import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Course, CourseDetail, Path, Phase, RoadLesson, RoadStudySet, RoadTask, StudySetKind, User } from '../types';
import { apiUrl } from '../config';
import { useSocket } from '../contexts/SocketContext';
import { computeRoadState, lockReasonText } from '../roadState';
import { CourseTree } from '../components/CourseTree';
import { QuestRoad, RoadSelection } from '../components/QuestRoad';
import { LessonModal } from '../components/LessonModal';
import { TaskModal } from '../components/TaskModal';
import { AddLessonModal } from '../components/AddLessonModal';
import { AddTaskModal } from '../components/AddTaskModal';
import { AddPathModal } from '../components/AddPathModal';
import { EditPathModal } from '../components/EditPathModal';
import { PhaseModal } from '../components/PhaseModal';
import { StudySetModal, StudySetTarget } from '../components/StudySetModal';
import { AlertDialog } from '../components/AlertDialog';
import { useDialog } from '../hooks/useDialog';

interface CoursePageProps {
  currentUser: User;
}

const TREE_COLLAPSED_KEY = 'course-tree-collapsed';

// Graph-position convention kept for the agent API / older clients (see docs/AGENT_API.md).
const LAYOUT = { firstX: 80, centerY: 250, lessonSpacingX: 250, firstTaskOffset: 120, taskSpacingX: 150 };

export const CoursePage: React.FC<CoursePageProps> = ({ currentUser }) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const { socket } = useSocket();
  const { alertState, showAlert, hideAlert } = useDialog();
  const isAdmin = currentUser.role === 'admin';

  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [courses, setCourses] = useState<Course[]>([]);
  const [selected, setSelected] = useState<RoadSelection>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(TREE_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const [enrolling, setEnrolling] = useState(false);

  // What is open on top of the road lives in the URL, so every dialog is a history entry:
  //   ?phase=<id>                               phase info (student) / phase editor (admin)
  //   ?lesson=<id>                              lesson
  //   ?lesson=<id>&task=<id>                    task (details tab)
  //   …&task=<id>&tab=submissions[&student=…]   admin: its submissions / one student's
  //   ?lesson=<id>&set=<id>                     quiz / flashcards
  // Opening pushes an entry, so the browser's Back button closes the dialog and returns to the
  // one it was opened from (student → students list → task → lesson → road); a deep link from
  // elsewhere (inbox, notification, notebook) still lands straight on the dialog.
  const view = useMemo(() => {
    const num = (k: string) => { const v = searchParams.get(k); return v && /^\d+$/.test(v) ? Number(v) : null; };
    return {
      phase: num('phase'), lesson: num('lesson'), task: num('task'), set: num('set'),
      tab: searchParams.get('tab') === 'submissions' ? 'submissions' as const : 'view' as const,
      student: searchParams.get('student'),
    };
  }, [searchParams]);
  // How many dialog entries this page pushed: Back pops one; a deep link (0) is replaced instead
  const depth: number = (location.state as { roadDepth?: number } | null)?.roadDepth || 0;
  const show = useCallback((params: Record<string, string | number | null | undefined>) => {
    const next: Record<string, string> = {};
    Object.entries(params).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== '') next[k] = String(v); });
    setSearchParams(next, { state: { roadDepth: depth + 1 } });
  }, [setSearchParams, depth]);
  const closeView = useCallback(() => {
    if (depth > 0) navigate(-1);
    else setSearchParams({}, { replace: true, state: { roadDepth: 0 } });
  }, [depth, navigate, setSearchParams]);

  // Dialogs that create content stay local: they are forms, not places to come back to
  const [addLesson, setAddLesson] = useState<Phase | null>(null);
  const [addTask, setAddTask] = useState<{ lesson: RoadLesson; phase: Phase } | null>(null);
  const [addPhaseOpen, setAddPhaseOpen] = useState(false);
  const [createStudySet, setCreateStudySet] = useState<StudySetTarget | null>(null);

  const fetchCourse = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(apiUrl(`/courses/${id}?t=${Date.now()}`), { credentials: 'include' });
      if (res.status === 404) { setNotFound(true); return; }
      if (res.ok) {
        const data: CourseDetail = await res.json();
        setCourse(data); // the open dialogs read from `course`, so fresh data shows at once
      }
    } catch (err) {
      console.error('Failed to fetch course', err);
    }
  }, [id]);

  const fetchCourses = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch(apiUrl('/courses'), { credentials: 'include' });
      if (res.ok) setCourses(await res.json());
    } catch (err) {
      console.error('Failed to fetch courses', err);
    }
  }, [isAdmin]);

  useEffect(() => { setNotFound(false); setSelected(null); fetchCourse(); fetchCourses(); }, [fetchCourse, fetchCourses]);

  // Live updates
  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchCourse();
    const mine = (data: { userId: number }) => { if (Number(data.userId) === Number(currentUser.id)) fetchCourse(); };
    const events = ['task:created', 'task:updated', 'task:deleted', 'task:submission_uploaded', 'lesson:created', 'lesson:updated', 'lesson:deleted', 'course:updated', 'study_set:created', 'study_set:updated', 'study_set:deleted'];
    events.forEach((e) => socket.on(e, refresh));
    socket.on('task:completed', mine);
    socket.on('task:viewed', mine);
    return () => {
      events.forEach((e) => socket.off(e, refresh));
      socket.off('task:completed', mine);
      socket.off('task:viewed', mine);
    };
  }, [socket, fetchCourse, currentUser.id]);

  // Admin teaching progress: mark a lesson as taught (or undo). Shown at once, then confirmed by a refetch.
  const toggleTaught = useCallback(async (lesson: RoadLesson) => {
    const taught = !lesson.taught_at;
    const patch = (c: CourseDetail | null) => c && ({
      ...c,
      phases: c.phases.map((p) => ({ ...p, lessons: p.lessons.map((l) => (l.id === lesson.id ? { ...l, taught_at: taught ? new Date().toISOString() : null } : l)) })),
    });
    setCourse(patch);
    try {
      const res = await fetch(apiUrl(`/lessons/${lesson.id}/taught`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ taught }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to update lesson');
    } catch (err: any) {
      showAlert('Error', err?.message || 'Failed to update lesson', 'danger');
    }
    fetchCourse();
  }, [fetchCourse, showAlert]);

  const phaseToPath = useCallback((phase: Phase): Path => ({
    id: String(phase.id), title: phase.name, description: phase.description, status: 'in-progress',
    requiredScore: phase.stars_required, course_id: course?.id ?? null, order_index: phase.order_index, requires_previous: phase.requires_previous,
  }), [course?.id]);

  const state = useMemo(() => (course ? computeRoadState(course, isAdmin) : null), [course, isAdmin]);

  // The open dialogs, resolved from the URL against the course (fresh data shows at once)
  const allLessons = useMemo(() => (course ? course.phases.flatMap((p) => p.lessons) : []), [course]);
  const phaseInfo = useMemo(() => (course && view.phase !== null ? course.phases.find((p) => p.id === view.phase) || null : null), [course, view.phase]);
  const taskModal = useMemo(() => (view.task !== null ? allLessons.flatMap((l) => l.tasks).find((t) => t.id === view.task) || null : null), [allLessons, view.task]);
  const taskLesson = useMemo(() => (taskModal ? allLessons.find((l) => l.tasks.some((t) => t.id === taskModal.id)) || null : null), [allLessons, taskModal]);
  const openSet = useMemo(() => (view.set !== null ? allLessons.flatMap((l) => l.study_sets || []).find((st) => st.id === view.set) || null : null), [allLessons, view.set]);
  const setLesson = useMemo(() => (openSet ? allLessons.find((l) => l.id === openSet.lesson_id) || null : null), [allLessons, openSet]);
  // The lesson dialog shows when nothing is open on top of it
  const lessonModal = useMemo(() => (view.lesson !== null && view.task === null && view.set === null ? allLessons.find((l) => l.id === view.lesson) || null : null), [allLessons, view]);
  const editPhase = useMemo(() => (isAdmin && phaseInfo ? phaseToPath(phaseInfo) : null), [isAdmin, phaseInfo, phaseToPath]);
  const studySet: StudySetTarget | null = useMemo(() => (openSet ? { mode: 'open', set: openSet } : createStudySet), [openSet, createStudySet]);
  // One object per task version: a new object on every render would make TaskModal reset itself
  const taskForModal = useMemo(() => (taskModal ? { ...taskModal, deadline: taskModal.deadline || undefined } : null), [taskModal]);

  // A URL that names something this course does not have (deleted, or another course's id)
  // falls back to the bare road — and the road follows the dialog: its node stays selected.
  useEffect(() => {
    if (!course) return;
    const wanted = view.phase !== null || view.lesson !== null || view.task !== null || view.set !== null;
    const found = taskModal || openSet || lessonModal || phaseInfo;
    if (wanted && !found) { setSearchParams({}, { replace: true, state: { roadDepth: 0 } }); return; }
    if (taskModal) setSelected({ type: 'task', id: taskModal.id });
    else if (openSet) setSelected({ type: 'study', id: openSet.id });
    else if (lessonModal) setSelected({ type: 'lesson', id: lessonModal.id });
    else if (phaseInfo) setSelected({ type: 'phase', id: phaseInfo.id });
  }, [course, view, taskModal, openSet, lessonModal, phaseInfo, setSearchParams]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try { localStorage.setItem(TREE_COLLAPSED_KEY, c ? '0' : '1'); } catch { /* ignore */ }
      return !c;
    });
  };

  const enrol = async () => {
    if (!course) return;
    setEnrolling(true);
    try {
      const res = await fetch(apiUrl(`/courses/${course.id}/enroll`), { method: 'POST', credentials: 'include' });
      if (res.ok) await fetchCourse();
      else showAlert('Error', 'Could not enrol. Please try again.', 'danger');
    } finally {
      setEnrolling(false);
    }
  };

  // ---- admin: create content (positions follow the legacy graph convention) ----
  const createLesson = async (phase: Phase, title: string, description: string) => {
    const last = phase.lessons[phase.lessons.length - 1];
    const body = {
      pathId: phase.id, title, description,
      x: last ? last.position_x + LAYOUT.lessonSpacingX : LAYOUT.firstX,
      y: LAYOUT.centerY,
      order: phase.lessons.length + 1,
      parentId: last ? last.id : null,
    };
    const res = await fetch(apiUrl('/lessons'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
    if (!res.ok) { showAlert('Error', 'Failed to create lesson', 'danger'); return; }
    setAddLesson(null);
    await fetchCourse();
  };

  const createTask = async (lesson: RoadLesson, title: string, type: 'mandatory' | 'optional', xp: number, deadline: string | null) => {
    const last = lesson.tasks[lesson.tasks.length - 1];
    const direction = lesson.order_index % 2 !== 0 ? -1 : 1;
    const body = {
      lessonId: lesson.id, title, type, xp, deadline,
      x: last ? last.position_x + LAYOUT.taskSpacingX : lesson.position_x + LAYOUT.firstTaskOffset,
      y: last ? last.position_y : lesson.position_y + LAYOUT.firstTaskOffset * direction,
      order: lesson.tasks.length + 1,
    };
    const res = await fetch(apiUrl('/tasks'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
    if (!res.ok) { showAlert('Error', 'Failed to create task', 'danger'); return; }
    setAddTask(null);
    await fetchCourse();
  };

  const openPhase = (phase: Phase) => { setSelected({ type: 'phase', id: phase.id }); show({ phase: phase.id }); };
  const openLesson = (lesson: RoadLesson) => { setSelected({ type: 'lesson', id: lesson.id }); show({ lesson: lesson.id }); };
  // A task or a set opened from its lesson keeps the lesson in the URL, so closing it returns there
  const openTask = (task: RoadTask) => { setSelected({ type: 'task', id: task.id }); show({ lesson: task.lesson_id, task: task.id }); };
  const openStudySet = (set: RoadStudySet) => { setSelected({ type: 'study', id: set.id }); show({ lesson: set.lesson_id, set: set.id }); };
  const addStudySet = (lesson: RoadLesson, kind: StudySetKind) => setCreateStudySet({ mode: 'create', lessonId: lesson.id, lessonTitle: lesson.title, kind });
  // Inside the task dialog: tab and student changes are history entries too
  const changeTaskView = ({ mode, student }: { mode: 'view' | 'submissions'; student: string | null }) => {
    if (!taskModal) return;
    if (mode === view.tab && (student || null) === (view.student || null)) return;
    show({ lesson: taskModal.lesson_id, task: taskModal.id, tab: mode === 'submissions' ? 'submissions' : null, student: mode === 'submissions' ? student : null });
  };
  const backToLesson = (lesson: RoadLesson | null) => (lesson ? { label: lesson.title, onClick: () => show({ lesson: lesson.id }) } : undefined);

  if (notFound) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-gray-500">
          <span className="material-icons text-6xl text-gray-300 mb-3">explore_off</span>
          <p className="font-semibold text-lg">This course does not exist.</p>
          <button onClick={() => navigate('/courses')} className="mt-4 text-primary-dark font-bold hover:underline">Back to courses</button>
        </div>
      </div>
    );
  }

  if (!course || !state) {
    return <div className="h-full flex items-center justify-center"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" /></div>;
  }

  const currentPhase = course.phases.find((p) => p.id === state.currentPhaseId) || null;
  const currentLesson = currentPhase?.lessons.find((l) => l.id === state.currentLessonId) || null;
  const teachingNow = isAdmin ? allLessons.find((l) => state.teach.get(l.id) === 'current') || null : null;
  const upNext = isAdmin ? allLessons.find((l) => state.teach.get(l.id) === 'next') || null : null;
  const taughtCount = allLessons.filter((l) => l.taught_at).length;
  const firstLocked = course.phases.find((p) => p.locked) || null;
  const firstLockedIndex = firstLocked ? course.phases.indexOf(firstLocked) : -1;
  const totalMandatory = course.phases.flatMap((p) => p.lessons).flatMap((l) => l.tasks).filter((t) => t.type === 'mandatory');
  const doneMandatory = totalMandatory.filter((t) => t.completed).length;
  const pct = totalMandatory.length > 0 ? Math.round((doneMandatory / totalMandatory.length) * 100) : 0;

  return (
    <div className="h-full flex gap-4 min-h-0">
      <AlertDialog isOpen={alertState.isOpen} title={alertState.title} message={alertState.message} variant={alertState.variant} onConfirm={hideAlert} />

      <CourseTree
        course={course}
        state={state}
        isAdmin={isAdmin}
        selected={selected}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
        onSelectPhase={(phase) => setSelected({ type: 'phase', id: phase.id })}
        onSelectLesson={(lesson) => setSelected({ type: 'lesson', id: lesson.id })}
        onSelectTask={(task) => setSelected({ type: 'task', id: task.id })}
        onOpenLesson={openLesson}
        onOpenTask={openTask}
        onOpenPhase={openPhase}
        onAddPhase={isAdmin ? () => setAddPhaseOpen(true) : undefined}
        onEditPhase={isAdmin ? openPhase : undefined}
        onAddLesson={isAdmin ? (phase) => setAddLesson(phase) : undefined}
        onAddTask={isAdmin ? (lesson, phase) => setAddTask({ lesson, phase }) : undefined}
        onOpenScript={isAdmin ? (lesson) => navigate(`/courses/${course.id}/lessons/${lesson.id}/script`) : undefined}
        onToggleTaught={isAdmin ? toggleTaught : undefined}
        onSelectStudySet={(set) => setSelected({ type: 'study', id: set.id })}
        onOpenStudySet={openStudySet}
        onAddStudySet={isAdmin ? addStudySet : undefined}
      />

      <section className="flex-1 min-w-0 h-full flex flex-col bg-white dark:bg-gray-900 rounded-3xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3 bg-white dark:bg-gray-900 z-10">
          <button onClick={() => navigate(isAdmin || !course.enrolled ? '/courses' : '/my-courses')} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex-shrink-0" title="Back to courses">
            <span className="material-icons">arrow_back</span>
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-extrabold italic text-gray-800 dark:text-white truncate">{course.name}</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {isAdmin
                ? teachingNow
                  ? <>Teaching now: <span className="font-bold text-green-700 dark:text-green-300">{teachingNow.title}</span>
                      {upNext && <> · next: <span className="font-bold text-blue-600 dark:text-blue-300">{upNext.title}</span></>}
                      {' '}· {taughtCount}/{allLessons.length} taught</>
                  : allLessons.length > 0 && taughtCount === allLessons.length
                    ? `All ${allLessons.length} lessons taught`
                    : `${course.phases.length} phases · ${allLessons.length} lessons · click a phase to edit it, use the outline to add content`
                : !course.enrolled
                  ? 'Enrol to start the road.'
                  : currentLesson
                    ? <>You are here: <span className="font-bold text-gray-700 dark:text-gray-200">{currentLesson.title}</span></>
                    : firstLocked
                      ? `${firstLocked.name.split(' — ')[0]} is locked: ${lockReasonText(firstLocked, firstLockedIndex > 0 ? course.phases[firstLockedIndex - 1] : null)}`
                      : totalMandatory.length > 0 ? 'Course complete — well done!' : 'No tasks published yet.'}
            </p>
          </div>
          {!isAdmin && course.enrolled && totalMandatory.length > 0 && (
            <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
              <div className="w-32 h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-primary to-green-500" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-xs font-bold text-gray-600 dark:text-gray-300 whitespace-nowrap">{doneMandatory}/{totalMandatory.length} · {pct}%</span>
            </div>
          )}
          {!isAdmin && !course.enrolled && (
            <button onClick={enrol} disabled={enrolling} className="flex items-center space-x-2 bg-amber-500 hover:bg-amber-600 text-white font-bold px-4 py-2 rounded-xl shadow-md transition-all disabled:opacity-50 flex-shrink-0">
              <span className="material-icons text-xl">how_to_reg</span>
              <span>{enrolling ? 'Enrolling…' : 'Enrol'}</span>
            </button>
          )}
          {!isAdmin && currentLesson && (
            <button onClick={() => setSelected({ type: 'lesson', id: currentLesson.id })} className="hidden md:flex items-center text-sm font-bold text-primary-dark dark:text-primary hover:underline flex-shrink-0" title="Scroll to where you are">
              <span className="material-icons text-base mr-1">my_location</span>Where am I?
            </button>
          )}
          {isAdmin && (
            <button onClick={() => setAddPhaseOpen(true)} className="flex items-center space-x-1.5 bg-primary hover:bg-primary-dark text-white font-bold px-3 py-2 rounded-xl shadow-md transition-colors flex-shrink-0 text-sm">
              <span className="material-icons text-base">add</span>
              <span>Phase</span>
            </button>
          )}
        </div>

        {/* The road */}
        <div className="flex-1 min-h-0">
          <QuestRoad
            course={course}
            state={state}
            isAdmin={isAdmin}
            selected={selected}
            onOpenPhase={openPhase}
            onOpenLesson={openLesson}
            onOpenTask={openTask}
            onOpenStudySet={openStudySet}
          />
        </div>
      </section>

      {/* Modals */}
      {!isAdmin && (
        <PhaseModal
          phase={phaseInfo}
          previous={phaseInfo ? course.phases[course.phases.indexOf(phaseInfo) - 1] || null : null}
          status={phaseInfo ? state.phases.get(phaseInfo.id) || 'open' : 'open'}
          onClose={closeView}
          onJumpToFirstLesson={phaseInfo && phaseInfo.lessons.length > 0 ? () => { setSelected({ type: 'lesson', id: phaseInfo.lessons[0].id }); closeView(); } : undefined}
        />
      )}
      <LessonModal
        lesson={lessonModal}
        taskStatus={(task) => state.tasks.get(task.id) || 'open'}
        isAdmin={isAdmin}
        onClose={closeView}
        onChanged={fetchCourse}
        onOpenTask={openTask}
        onOpenScript={isAdmin && lessonModal ? () => navigate(`/courses/${course.id}/lessons/${lessonModal.id}/script`) : undefined}
        onToggleTaught={isAdmin && lessonModal ? () => toggleTaught(lessonModal) : undefined}
        studySetStatus={(set) => state.studySets.get(set.id) || 'open'}
        phaseLocked={!isAdmin && lessonModal !== null && !lessonModal.unlocked && course.phases.some((p) => p.locked && p.lessons.some((l) => l.id === lessonModal.id))}
        onOpenStudySet={openStudySet}
        onAddStudySet={isAdmin && lessonModal ? (kind) => addStudySet(lessonModal, kind) : undefined}
      />
      <StudySetModal
        target={studySet}
        isAdmin={isAdmin}
        onClose={() => (openSet ? closeView() : setCreateStudySet(null))}
        onChanged={fetchCourse}
        onBack={openSet ? backToLesson(setLesson) : undefined}
      />
      {taskForModal && (
        <TaskModal
          task={taskForModal}
          isOpen={true}
          onClose={() => { closeView(); fetchCourse(); }}
          isAdmin={isAdmin}
          currentUserId={currentUser.id}
          currentUser={currentUser}
          onUpdate={fetchCourse}
          initialMode={isAdmin ? view.tab : 'view'}
          initialStudent={isAdmin && view.tab === 'submissions' ? view.student : null}
          onViewChange={isAdmin ? changeTaskView : undefined}
          onBack={backToLesson(taskLesson)}
        />
      )}
      {isAdmin && (
        <>
          <AddLessonModal
            isOpen={addLesson !== null}
            phaseName={addLesson?.name || ''}
            onClose={() => setAddLesson(null)}
            onSubmit={(title, description) => (addLesson ? createLesson(addLesson, title, description) : Promise.resolve())}
          />
          <AddTaskModal
            isOpen={addTask !== null}
            lessonTitle={addTask?.lesson.title || ''}
            onClose={() => setAddTask(null)}
            onSubmit={(title, type, xp, deadline) => (addTask ? createTask(addTask.lesson, title, type, xp, deadline) : Promise.resolve())}
          />
          <AddPathModal isOpen={addPhaseOpen} courses={courses} defaultCourseId={course.id} onClose={() => setAddPhaseOpen(false)} onSuccess={fetchCourse} />
          <EditPathModal isOpen={editPhase !== null} path={editPhase} courses={courses} onClose={closeView} onSuccess={fetchCourse} />
        </>
      )}
    </div>
  );
};
