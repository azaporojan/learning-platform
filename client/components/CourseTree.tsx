import React, { useEffect, useState } from 'react';
import { CourseDetail, Phase, RoadLesson, RoadTask } from '../types';
import { RoadState, NodeStatus, shortPhaseName, lockReasonText } from '../roadState';
import { RoadSelection } from './QuestRoad';

interface CourseTreeProps {
  course: CourseDetail;
  state: RoadState;
  isAdmin: boolean;
  selected: RoadSelection;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectPhase: (phase: Phase) => void;
  onSelectLesson: (lesson: RoadLesson, phase: Phase) => void;
  onSelectTask: (task: RoadTask, lesson: RoadLesson, phase: Phase) => void;
  onOpenLesson: (lesson: RoadLesson, phase: Phase) => void;
  onOpenTask: (task: RoadTask, lesson: RoadLesson, phase: Phase) => void;
  onOpenPhase?: (phase: Phase) => void;
  // Admin only
  onAddPhase?: () => void;
  onEditPhase?: (phase: Phase) => void;
  onAddLesson?: (phase: Phase) => void;
  onAddTask?: (lesson: RoadLesson, phase: Phase) => void;
  onOpenScript?: (lesson: RoadLesson, phase: Phase) => void;
}

// Left pane: the course as a bullet tree (course → phases → lessons → tasks). Clicking an item
// highlights and scrolls to its stop on the road; the small arrow opens it.
export const CourseTree: React.FC<CourseTreeProps> = ({
  course, state, isAdmin, selected, collapsed, onToggleCollapse,
  onSelectPhase, onSelectLesson, onSelectTask, onOpenLesson, onOpenTask, onOpenPhase,
  onAddPhase, onEditPhase, onAddLesson, onAddTask, onOpenScript,
}) => {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [initialised, setInitialised] = useState(false);

  // Expand the phase the student is on (or the first one) the first time the course loads
  useEffect(() => {
    if (initialised || course.phases.length === 0) return;
    const first = state.currentPhaseId ?? course.phases[0].id;
    setExpanded(new Set([first]));
    setInitialised(true);
  }, [course, state, initialised]);

  // Keep the phase of the selected node open
  useEffect(() => {
    if (!selected) return;
    const phase = course.phases.find((p) =>
      (selected.type === 'phase' && p.id === selected.id) ||
      p.lessons.some((l) => (selected.type === 'lesson' && l.id === selected.id) || (selected.type === 'task' && l.tasks.some((t) => t.id === selected.id)))
    );
    if (phase && !expanded.has(phase.id)) setExpanded((prev) => new Set(prev).add(phase.id));
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePhase = (id: number) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const isSel = (type: string, id: number) => selected !== null && selected.type === type && selected.id === id;

  if (collapsed) {
    return (
      <aside className="h-full w-14 flex-shrink-0 bg-card-light dark:bg-card-dark rounded-3xl border border-gray-200 dark:border-gray-700 shadow-sm flex flex-col items-center py-3 gap-2">
        <button onClick={onToggleCollapse} title="Expand course outline" className="w-9 h-9 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center justify-center text-gray-500">
          <span className="material-icons">chevron_right</span>
        </button>
        <div className="w-8 border-t border-gray-200 dark:border-gray-700 my-1" />
        {course.phases.map((phase) => {
          const st = state.phases.get(phase.id) || 'open';
          return (
            <button
              key={phase.id}
              onClick={() => onSelectPhase(phase)}
              title={phase.name}
              className={`w-9 h-9 rounded-xl flex items-center justify-center text-sm font-extrabold border-2 transition-transform hover:scale-110 ${railClasses(st)} ${isSel('phase', phase.id) ? 'ring-2 ring-primary' : ''}`}
            >
              {st === 'locked' ? <span className="material-icons text-base">lock</span> : phase.order_index}
            </button>
          );
        })}
      </aside>
    );
  }

  let lessonNumber = 0;

  return (
    <aside className="h-full w-80 flex-shrink-0 bg-card-light dark:bg-card-dark rounded-3xl border border-gray-200 dark:border-gray-700 shadow-sm flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Course</div>
          <h3 className="font-extrabold italic text-gray-800 dark:text-gray-100 truncate" title={course.name}>{course.name}</h3>
        </div>
        <button onClick={onToggleCollapse} title="Collapse" className="w-9 h-9 flex-shrink-0 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center justify-center text-gray-500">
          <span className="material-icons">chevron_left</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar py-2">
        <ul className="space-y-1 px-2">
          {course.phases.map((phase, phaseIndex) => {
            const pst = state.phases.get(phase.id) || 'open';
            const open = expanded.has(phase.id);
            const previous = phaseIndex > 0 ? course.phases[phaseIndex - 1] : null;
            const done = phase.lessons.filter((l) => l.completed).length;
            return (
              <li key={phase.id}>
                <div className={`group flex items-center gap-1 rounded-xl px-1.5 py-1.5 ${isSel('phase', phase.id) ? 'bg-primary/15' : 'hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                  <button onClick={() => togglePhase(phase.id)} className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" title={open ? 'Collapse phase' : 'Expand phase'}>
                    <span className={`material-icons text-lg transition-transform ${open ? 'rotate-90' : ''}`}>chevron_right</span>
                  </button>
                  <StatusDot status={pst} isAdmin={isAdmin} kind="phase" />
                  <button onClick={() => onSelectPhase(phase)} className="flex-1 min-w-0 text-left" title={phase.locked ? `${phase.name} — ${lockReasonText(phase, previous)}` : phase.name}>
                    <div className={`text-sm font-extrabold truncate ${pst === 'locked' ? 'text-gray-400' : 'text-gray-800 dark:text-gray-100'}`}>
                      {shortPhaseName(phase)}
                      <span className="ml-1 font-semibold text-gray-400">· {phase.lessons.length}</span>
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                      {phase.locked ? lockReasonText(phase, previous) : isAdmin ? phase.name.replace(/^.*?—\s*/, '') : `${done}/${phase.lessons.length} lessons done`}
                    </div>
                  </button>
                  {!isAdmin && onOpenPhase && (
                    <button onClick={() => onOpenPhase(phase)} title="About this phase" className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:text-primary-dark hover:bg-white dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="material-icons text-base">info_outline</span>
                    </button>
                  )}
                  {isAdmin && onEditPhase && (
                    <button onClick={() => onEditPhase(phase)} title="Edit phase" className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:text-primary-dark hover:bg-white dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="material-icons text-base">edit</span>
                    </button>
                  )}
                </div>

                {open && (
                  <ul className="ml-5 mt-1 space-y-0.5 border-l border-gray-200 dark:border-gray-700 pl-2">
                    {phase.lessons.map((lesson) => {
                      lessonNumber += 1;
                      const n = lessonNumber;
                      const lst = state.lessons.get(lesson.id) || 'open';
                      const canOpen = true; // a locked lesson can be read (summary + task titles); its tasks stay locked
                      return (
                        <li key={lesson.id}>
                          <div className={`group flex items-center gap-1.5 rounded-lg px-1.5 py-1 ${isSel('lesson', lesson.id) ? 'bg-primary/15' : 'hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                            <StatusDot status={lst} isAdmin={isAdmin} kind="lesson" number={n} />
                            <button onClick={() => onSelectLesson(lesson, phase)} className="flex-1 min-w-0 text-left" title={lesson.title}>
                              <span className={`block text-[13px] leading-tight font-semibold line-clamp-2 ${lst === 'locked' ? 'text-gray-400' : lst === 'completed' ? 'text-green-700 dark:text-green-300' : 'text-gray-700 dark:text-gray-200'}`}>
                                {lesson.title}
                              </span>
                            </button>
                            {isAdmin && onOpenScript && (
                              <button onClick={() => onOpenScript(lesson, phase)} title="Lesson script (admin only)" className="w-6 h-6 rounded-full flex items-center justify-center text-gray-400 hover:text-purple-600 opacity-0 group-hover:opacity-100 transition-opacity">
                                <span className="material-icons text-base">description</span>
                              </button>
                            )}
                            {isAdmin && onAddTask && (
                              <button onClick={() => onAddTask(lesson, phase)} title="Add task" className="w-6 h-6 rounded-full flex items-center justify-center text-gray-400 hover:text-green-600 opacity-0 group-hover:opacity-100 transition-opacity">
                                <span className="material-icons text-base">add_task</span>
                              </button>
                            )}
                            {canOpen && (
                              <button onClick={() => onOpenLesson(lesson, phase)} title="Open lesson" className="w-6 h-6 rounded-full flex items-center justify-center text-gray-400 hover:text-primary-dark opacity-0 group-hover:opacity-100 transition-opacity">
                                <span className="material-icons text-base">open_in_new</span>
                              </button>
                            )}
                          </div>
                          {lesson.tasks.length > 0 && (
                            <ul className="ml-6 space-y-0.5">
                              {lesson.tasks.map((task) => {
                                const tst = state.tasks.get(task.id) || 'open';
                                const tCanOpen = isAdmin || tst !== 'locked';
                                return (
                                  <li key={task.id} className={`group flex items-center gap-1.5 rounded-md px-1.5 py-0.5 ${isSel('task', task.id) ? 'bg-primary/15' : 'hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                                    <TaskDot status={tst} type={task.type} isAdmin={isAdmin} />
                                    <button onClick={() => onSelectTask(task, lesson, phase)} className="flex-1 min-w-0 text-left" title={task.title}>
                                      <span className={`block text-[12px] leading-tight truncate ${tst === 'locked' ? 'text-gray-400' : tst === 'completed' ? 'text-green-700 dark:text-green-300 line-through decoration-green-400' : 'text-gray-600 dark:text-gray-300'}`}>
                                        {task.title}
                                      </span>
                                    </button>
                                    {isAdmin && (task.unviewed_count || 0) > 0 && (
                                      <span className="min-w-[16px] h-4 px-1 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">{task.unviewed_count}</span>
                                    )}
                                    {!isAdmin && task.is_new && !task.completed && tst !== 'locked' && (
                                      <span className="text-[8px] font-bold text-blue-600 bg-blue-100 rounded-full px-1.5">NEW</span>
                                    )}
                                    {tCanOpen && (
                                      <button onClick={() => onOpenTask(task, lesson, phase)} title="Open task" className="w-5 h-5 rounded-full flex items-center justify-center text-gray-400 hover:text-primary-dark opacity-0 group-hover:opacity-100 transition-opacity">
                                        <span className="material-icons text-sm">open_in_new</span>
                                      </button>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                    {isAdmin && onAddLesson && (
                      <li>
                        <button onClick={() => onAddLesson(phase)} className="flex items-center gap-1.5 px-1.5 py-1 text-[12px] font-bold text-green-600 hover:text-green-700 hover:underline">
                          <span className="material-icons text-base">add_circle_outline</span>Add lesson
                        </button>
                      </li>
                    )}
                    {phase.lessons.length === 0 && !isAdmin && <li className="px-1.5 py-1 text-[12px] italic text-gray-400">No lessons yet.</li>}
                  </ul>
                )}
              </li>
            );
          })}
          {isAdmin && onAddPhase && (
            <li>
              <button onClick={onAddPhase} className="w-full flex items-center gap-2 rounded-xl px-2 py-2 text-sm font-bold text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 border border-dashed border-green-300 mt-2">
                <span className="material-icons text-lg">add</span>Add phase
              </button>
            </li>
          )}
        </ul>
      </div>

      {/* Legend */}
      <div className="px-4 py-2.5 border-t border-gray-200 dark:border-gray-700 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-semibold text-gray-500 dark:text-gray-400">
        {isAdmin ? (
          <>
            <span className="flex items-center gap-1"><span className="material-icons text-sm text-blue-500">assignment</span>Mandatory task</span>
            <span className="flex items-center gap-1"><span className="material-icons text-sm text-yellow-500">stars</span>Optional task</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-red-500 inline-block" />Submissions to review</span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1"><span className="material-icons text-sm text-green-600">close</span>Done</span>
            <span className="flex items-center gap-1"><span className="material-icons text-sm text-primary-dark">flag</span>You are here</span>
            <span className="flex items-center gap-1"><span className="font-extrabold text-gray-400 w-3.5 text-center">?</span>Not reached yet</span>
            <span className="flex items-center gap-1"><span className="material-icons text-sm text-gray-400">lock</span>Locked phase</span>
          </>
        )}
      </div>
    </aside>
  );
};

function railClasses(status: NodeStatus): string {
  switch (status) {
    case 'locked': return 'bg-gray-100 border-gray-300 text-gray-400 dark:bg-gray-800 dark:border-gray-600';
    case 'completed': return 'bg-green-500 border-green-600 text-white';
    case 'current': return 'bg-primary border-primary-dark text-white';
    default: return 'bg-white border-primary text-primary-dark dark:bg-gray-900 dark:text-primary';
  }
}

const StatusDot: React.FC<{ status: NodeStatus; isAdmin: boolean; kind: 'phase' | 'lesson'; number?: number }> = ({ status, isAdmin, kind, number }) => {
  const base = `flex-shrink-0 flex items-center justify-center rounded-full border-2 ${kind === 'phase' ? 'w-6 h-6' : 'w-5 h-5 text-[10px]'} font-extrabold`;
  if (isAdmin) return <span className={`${base} bg-blue-50 border-blue-400 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200`}>{kind === 'lesson' ? number : <span className="material-icons text-sm">flag</span>}</span>;
  switch (status) {
    case 'completed': return <span className={`${base} bg-green-500 border-green-600 text-white`}><span className="material-icons text-sm font-black">close</span></span>;
    case 'current': return <span className={`${base} bg-primary border-primary-dark text-white`}><span className="material-icons text-sm">flag</span></span>;
    case 'locked': return <span className={`${base} bg-gray-100 border-gray-300 text-gray-400 dark:bg-gray-800 dark:border-gray-600`}>{kind === 'phase' ? <span className="material-icons text-sm">lock</span> : '?'}</span>;
    default: return <span className={`${base} bg-white border-primary text-primary-dark dark:bg-gray-900 dark:text-primary`}>{kind === 'lesson' ? number : <span className="material-icons text-sm">flag</span>}</span>;
  }
};

const TaskDot: React.FC<{ status: NodeStatus; type: 'mandatory' | 'optional'; isAdmin: boolean }> = ({ status, type, isAdmin }) => {
  const base = 'flex-shrink-0 w-4 h-4 rounded-full border flex items-center justify-center text-[9px] font-extrabold';
  if (!isAdmin) {
    if (status === 'completed') return <span className={`${base} bg-green-50 border-green-400 text-green-600`}><span className="material-icons text-[11px]">check</span></span>;
    if (status === 'current') return <span className={`${base} bg-primary border-primary-dark text-white`}><span className="material-icons text-[11px]">flag</span></span>;
    if (status === 'locked') return <span className={`${base} bg-gray-100 border-gray-300 text-gray-400 dark:bg-gray-800 dark:border-gray-600`}>?</span>;
  }
  return type === 'mandatory'
    ? <span className={`${base} bg-blue-50 border-blue-400 text-blue-500`}><span className="material-icons text-[11px]">assignment</span></span>
    : <span className={`${base} bg-yellow-50 border-yellow-300 text-yellow-500`}><span className="material-icons text-[11px]">stars</span></span>;
};
