import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
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

  // Modals
  const [lessonModal, setLessonModal] = useState<RoadLesson | null>(null);
  const [taskModal, setTaskModal] = useState<RoadTask | null>(null);
  const [taskModalMode, setTaskModalMode] = useState<'view' | 'submissions'>('view');
  const [addLesson, setAddLesson] = useState<Phase | null>(null);
  const [addTask, setAddTask] = useState<{ lesson: RoadLesson; phase: Phase } | null>(null);
  const [addPhaseOpen, setAddPhaseOpen] = useState(false);
  const [editPhase, setEditPhase] = useState<Path | null>(null);
  const [phaseInfo, setPhaseInfo] = useState<Phase | null>(null);
  const [studySet, setStudySet] = useState<StudySetTarget | null>(null);

  const fetchCourse = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(apiUrl(`/courses/${id}?t=${Date.now()}`), { credentials: 'include' });
      if (res.status === 404) { setNotFound(true); return; }
      if (res.ok) {
        const data: CourseDetail = await res.json();
        setCourse(data);
        // Keep the open lesson modal in sync with fresh data
        setLessonModal((prev) => (prev ? data.phases.flatMap((p) => p.lessons).find((l) => l.id === prev.id) || null : prev));
        setPhaseInfo((prev) => (prev ? data.phases.find((p) => p.id === prev.id) || null : prev));
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

  const state = useMemo(() => (course ? computeRoadState(course, isAdmin) : null), [course, isAdmin]);

  // Deep link from the submissions inbox (and notifications): /courses/:id?lesson=<id>&task=<id>
  // selects the node on the road and opens the task (or the lesson), then clears the query.
  useEffect(() => {
    if (!course) return;
    const lessonParam = searchParams.get('lesson');
    const taskParam = searchParams.get('task');
    if (!lessonParam && !taskParam) return;
    const lessons = course.phases.flatMap((p) => p.lessons);
    const lesson = lessons.find((l) => String(l.id) === lessonParam) || lessons.find((l) => l.tasks.some((t) => String(t.id) === taskParam));
    const task = lesson?.tasks.find((t) => String(t.id) === taskParam) || null;
    if (task) { setSelected({ type: 'task', id: task.id }); setTaskModalMode(isAdmin ? 'submissions' : 'view'); setTaskModal(task); }
    else if (lesson) { setSelected({ type: 'lesson', id: lesson.id }); setLessonModal(lesson); }
    setSearchParams({}, { replace: true });
  }, [course, searchParams, setSearchParams]);

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

  const phaseToPath = (phase: Phase): Path => ({
    id: String(phase.id), title: phase.name, description: phase.description, status: 'in-progress',
    requiredScore: phase.stars_required, course_id: course?.id ?? null, order_index: phase.order_index, requires_previous: phase.requires_previous,
  });

  const openPhase = (phase: Phase) => {
    setSelected({ type: 'phase', id: phase.id });
    if (isAdmin) setEditPhase(phaseToPath(phase));
    else setPhaseInfo(phase);
  };
  const openLesson = (lesson: RoadLesson) => { setSelected({ type: 'lesson', id: lesson.id }); setLessonModal(lesson); };
  const openTask = (task: RoadTask) => { setSelected({ type: 'task', id: task.id }); setTaskModalMode('view'); setTaskModal(task); };
  const openStudySet = (set: RoadStudySet) => { setSelected({ type: 'study', id: set.id }); setStudySet({ mode: 'open', set }); };
  const addStudySet = (lesson: RoadLesson, kind: StudySetKind) => setStudySet({ mode: 'create', lessonId: lesson.id, lessonTitle: lesson.title, kind });

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
        onEditPhase={isAdmin ? (phase) => setEditPhase(phaseToPath(phase)) : undefined}
        onAddLesson={isAdmin ? (phase) => setAddLesson(phase) : undefined}
        onAddTask={isAdmin ? (lesson, phase) => setAddTask({ lesson, phase }) : undefined}
        onOpenScript={isAdmin ? (lesson) => navigate(`/courses/${course.id}/lessons/${lesson.id}/script`) : undefined}
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
                ? `${course.phases.length} phases · ${course.phases.reduce((n, p) => n + p.lessons.length, 0)} lessons · click a phase to edit it, use the outline to add content`
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
      <PhaseModal
        phase={phaseInfo}
        previous={phaseInfo ? course.phases[course.phases.indexOf(phaseInfo) - 1] || null : null}
        status={phaseInfo ? state.phases.get(phaseInfo.id) || 'open' : 'open'}
        onClose={() => setPhaseInfo(null)}
        onJumpToFirstLesson={phaseInfo && phaseInfo.lessons.length > 0 ? () => { setSelected({ type: 'lesson', id: phaseInfo.lessons[0].id }); setPhaseInfo(null); } : undefined}
      />
      <LessonModal
        lesson={lessonModal}
        taskStatus={(task) => state.tasks.get(task.id) || 'open'}
        isAdmin={isAdmin}
        onClose={() => setLessonModal(null)}
        onChanged={fetchCourse}
        onOpenTask={(task) => { setLessonModal(null); openTask(task); }}
        onOpenScript={isAdmin && lessonModal ? () => navigate(`/courses/${course.id}/lessons/${lessonModal.id}/script`) : undefined}
        studySetStatus={(set) => state.studySets.get(set.id) || 'open'}
        onOpenStudySet={(set) => { setLessonModal(null); openStudySet(set); }}
        onAddStudySet={isAdmin && lessonModal ? (kind) => { const l = lessonModal; setLessonModal(null); addStudySet(l, kind); } : undefined}
      />
      <StudySetModal target={studySet} isAdmin={isAdmin} onClose={() => setStudySet(null)} onChanged={fetchCourse} />
      {taskModal && (
        <TaskModal
          task={{ ...taskModal, deadline: taskModal.deadline || undefined }}
          isOpen={true}
          onClose={() => { setTaskModal(null); fetchCourse(); }}
          isAdmin={isAdmin}
          currentUserId={currentUser.id}
          currentUser={currentUser}
          onUpdate={fetchCourse}
          initialMode={taskModalMode}
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
          <EditPathModal isOpen={editPhase !== null} path={editPhase} courses={courses} onClose={() => setEditPhase(null)} onSuccess={fetchCourse} />
        </>
      )}
    </div>
  );
};
