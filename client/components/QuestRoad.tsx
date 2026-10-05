import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CourseDetail, Phase, RoadLesson, RoadTask } from '../types';
import { RoadState, NodeStatus, shortPhaseName, lockReasonText } from '../roadState';

export type RoadSelection = { type: 'phase' | 'lesson' | 'task'; id: number } | null;

interface QuestRoadProps {
  course: CourseDetail;
  state: RoadState;
  isAdmin: boolean;
  selected: RoadSelection;
  onOpenPhase: (phase: Phase) => void;
  onOpenLesson: (lesson: RoadLesson, phase: Phase) => void;
  onOpenTask: (task: RoadTask, lesson: RoadLesson, phase: Phase) => void;
}

interface Stop {
  key: string;
  kind: 'phase' | 'lesson';
  phase: Phase;
  phaseIndex: number;
  lesson?: RoadLesson;
  lessonNumber?: number; // 1-based across the whole course
}

// Layout constants (px)
const PAD_X = 28;
const PAD_TOP = 16;
const PAD_BOTTOM = 16;
const CELL_W_TARGET = 100;
const ROW_H_MIN = 140;
const ROW_H_MAX = 250;
const NODE_OFFSET_Y = 62;   // node centre below the row top (label sits above)
const TASK_FIRST_DY = 44;   // first task centre below the lesson centre
const TASK_STEP = 32;

const PHASE_SIZE = 50;
const LESSON_SIZE = 44;
const TASK_SIZE = 26;

// One winding road for the whole course: phases and lessons are "stops" laid out in a snake
// (left→right, then right→left on the next row) so the full course fits the available width.
// Each lesson's tasks hang below their lesson. Everything is derived from order, not from the
// stored x/y of the old free-form graph.
export const QuestRoad: React.FC<QuestRoadProps> = ({ course, state, isAdmin, selected, onOpenPhase, onOpenLesson, onOpenTask }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stops = useMemo<Stop[]>(() => {
    const list: Stop[] = [];
    let n = 0;
    course.phases.forEach((phase, phaseIndex) => {
      list.push({ key: `phase-${phase.id}`, kind: 'phase', phase, phaseIndex });
      phase.lessons.forEach((lesson) => {
        n += 1;
        list.push({ key: `lesson-${lesson.id}`, kind: 'lesson', phase, phaseIndex, lesson, lessonNumber: n });
      });
    });
    return list;
  }, [course]);

  // Grid: as many columns as fit the width, rows sized to fit the height (within limits)
  const layout = useMemo(() => {
    const width = Math.max(size.width, 360);
    const cols = Math.max(3, Math.floor((width - 2 * PAD_X) / CELL_W_TARGET));
    const cellW = (width - 2 * PAD_X) / cols;
    const rows = Math.max(1, Math.ceil(stops.length / cols));
    const available = Math.max(size.height - PAD_TOP - PAD_BOTTOM, ROW_H_MIN);
    const rowH = Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, available / rows));
    const points = stops.map((_, i) => {
      const row = Math.floor(i / cols);
      const colRaw = i % cols;
      const col = row % 2 === 0 ? colRaw : cols - 1 - colRaw;
      return { x: PAD_X + col * cellW + cellW / 2, y: PAD_TOP + row * rowH + NODE_OFFSET_Y };
    });
    return { cols, cellW, rows, rowH, points, height: PAD_TOP + rows * rowH + PAD_BOTTOM, width };
  }, [size, stops]);

  // Index of the stop the student is on (the road is painted green up to here)
  const currentIndex = useMemo(() => {
    if (isAdmin) return -1;
    if (state.currentLessonId !== null) return stops.findIndex((s) => s.kind === 'lesson' && s.lesson!.id === state.currentLessonId);
    // Nothing current: either everything is done, or everything is locked
    let last = -1;
    stops.forEach((s, i) => {
      const st = s.kind === 'phase' ? state.phases.get(s.phase.id) : state.lessons.get(s.lesson!.id);
      if (st === 'completed') last = i;
    });
    return last;
  }, [stops, state, isAdmin]);

  // Scroll the selected node into view and flash it
  useEffect(() => {
    if (!selected) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-road-node="${selected.type}-${selected.id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }, [selected]);

  const roadPoints = layout.points.map((p) => `${p.x},${p.y}`).join(' ');
  const donePoints = currentIndex >= 0 ? layout.points.slice(0, currentIndex + 1).map((p) => `${p.x},${p.y}`).join(' ') : '';
  const isSelected = (type: string, id: number) => selected !== null && selected.type === type && selected.id === id;
  const lastRow = (index: number) => Math.floor(index / layout.cols) === layout.rows - 1;
  const hasSelection = (stop: Stop) =>
    selected !== null && stop.kind === 'lesson' && (
      (selected.type === 'lesson' && selected.id === stop.lesson!.id) ||
      (selected.type === 'task' && stop.lesson!.tasks.some((t) => t.id === selected.id)));

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-auto custom-scrollbar bg-white dark:bg-gray-950">
      <div className="relative" style={{ width: '100%', height: `${layout.height}px`, minWidth: '360px' }}>
        {/* The road */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" width={layout.width} height={layout.height}>
          <polyline points={roadPoints} fill="none" stroke="currentColor" className="text-gray-200 dark:text-gray-800" strokeWidth={18} strokeLinejoin="round" strokeLinecap="round" />
          <polyline points={roadPoints} fill="none" stroke="currentColor" className="text-gray-300 dark:text-gray-700" strokeWidth={2} strokeDasharray="10 10" strokeLinejoin="round" strokeLinecap="round" />
          {donePoints && (
            <polyline points={donePoints} fill="none" stroke="#22c55e" strokeWidth={8} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
          )}
        </svg>

        {/* Stops */}
        {stops.map((stop, i) => {
          const p = layout.points[i];
          const labelWidth = Math.min(Math.max(layout.cellW - 6, 92), 170);

          if (stop.kind === 'phase') {
            const phase = stop.phase;
            const status = state.phases.get(phase.id) || 'open';
            const previous = stop.phaseIndex > 0 ? course.phases[stop.phaseIndex - 1] : null;
            const reason = phase.locked ? lockReasonText(phase, previous) : '';
            const sel = isSelected('phase', phase.id);
            return (
              <div key={stop.key} className={`absolute group hover:z-50 ${sel ? 'z-40' : 'z-10'}`} style={{ left: p.x, top: p.y, transform: 'translate(-50%, -50%)' }}>
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 text-center pointer-events-none" style={{ width: labelWidth }}>
                  <span className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-extrabold uppercase tracking-wide shadow-sm border ${
                    status === 'locked' ? 'bg-gray-100 text-gray-400 border-gray-200 dark:bg-gray-800 dark:border-gray-700'
                    : status === 'completed' ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800'
                    : 'bg-primary/15 text-primary-dark border-primary/40 dark:text-primary'
                  } ${sel ? 'ring-2 ring-primary' : ''}`}>
                    {shortPhaseName(phase)}
                  </span>
                </div>
                <button
                  type="button"
                  data-road-node={`phase-${phase.id}`}
                  onClick={() => onOpenPhase(phase)}
                  title={phase.name + (reason ? ` — ${reason}` : '')}
                  className={`relative flex items-center justify-center rounded-2xl rotate-45 shadow-lg border-4 transition-transform hover:scale-110 ${phaseClasses(status)} ${sel ? 'ring-4 ring-primary/50 scale-110' : ''}`}
                  style={{ width: PHASE_SIZE, height: PHASE_SIZE }}
                >
                  <span className="-rotate-45 flex items-center justify-center">
                    {status === 'locked' ? <span className="material-icons text-xl">lock</span>
                      : status === 'completed' ? <span className="material-icons text-2xl font-black">close</span>
                      : status === 'current' ? <span className="material-icons text-xl">flag</span>
                      : <span className="font-extrabold text-base">{phase.order_index}</span>}
                  </span>
                  {status === 'current' && <span className="absolute inset-0 rounded-2xl bg-primary/40 animate-ping" />}
                </button>
                <Tooltip text={phase.name} sub={reason || `${phase.lessons.length} lessons`} above={lastRow(i)} />
              </div>
            );
          }

          const lesson = stop.lesson!;
          const status = state.lessons.get(lesson.id) || 'open';
          const sel = isSelected('lesson', lesson.id);
          const unviewed = isAdmin ? lesson.tasks.reduce((n, t) => n + (t.unviewed_count || 0), 0) : 0;
          const hasNew = !isAdmin && lesson.tasks.some((t) => t.is_new && !t.completed) && status !== 'locked';
          return (
            <div key={stop.key} className="absolute" style={{ left: p.x, top: p.y, zIndex: hasSelection(stop) ? 30 : undefined }}>
              {/* Label above the node */}
              <div className="absolute left-1/2 -translate-x-1/2 pointer-events-none" style={{ bottom: LESSON_SIZE / 2 + 6, width: labelWidth }}>
                <div className={`mx-auto text-center text-[11px] leading-[14px] font-bold px-1.5 py-1 rounded-lg border shadow-sm line-clamp-2 ${
                  status === 'locked' ? 'bg-white/90 text-gray-400 border-gray-200 dark:bg-gray-900 dark:border-gray-800'
                  : status === 'completed' ? 'bg-white text-green-700 border-green-200 dark:bg-gray-900 dark:text-green-300 dark:border-green-900'
                  : status === 'current' ? 'bg-white text-gray-900 border-primary dark:bg-gray-900 dark:text-white'
                  : 'bg-white text-gray-700 border-gray-200 dark:bg-gray-900 dark:text-gray-200 dark:border-gray-700'
                } ${sel ? 'ring-2 ring-primary' : ''}`}>
                  {lesson.title}
                </div>
              </div>

              {/* Lesson node */}
              <div className={`absolute group hover:z-50 ${sel ? 'z-40' : 'z-10'}`} style={{ left: 0, top: 0, transform: 'translate(-50%, -50%)' }}>
                <button
                  type="button"
                  data-road-node={`lesson-${lesson.id}`}
                  onClick={() => onOpenLesson(lesson, stop.phase)}
                  title={lesson.title}
                  className={`relative flex items-center justify-center rounded-full shadow-md border-[3px] transition-transform hover:scale-110 cursor-pointer ${lessonClasses(status, isAdmin)} ${sel ? 'ring-4 ring-primary/50 scale-110' : ''}`}
                  style={{ width: LESSON_SIZE, height: LESSON_SIZE }}
                >
                  {isAdmin ? <span className="font-extrabold text-sm">{stop.lessonNumber}</span>
                    : status === 'completed' ? <span className="material-icons text-2xl font-black">close</span>
                    : status === 'current' ? <span className="material-icons text-xl">flag</span>
                    : status === 'locked' ? <span className="font-extrabold text-lg">?</span>
                    : <span className="font-extrabold text-sm">{stop.lessonNumber}</span>}
                  {status === 'current' && <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping" />}
                  {unviewed > 0 && (
                    <span className="absolute -top-2 -right-2 min-w-[20px] h-5 px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white shadow z-10 animate-bounce">
                      {unviewed}
                    </span>
                  )}
                  {hasNew && (
                    <span className="absolute -top-2 -right-2 h-5 px-1.5 bg-gradient-to-br from-blue-500 to-blue-600 text-white text-[8px] font-bold rounded-full flex items-center justify-center border-2 border-white shadow z-10 animate-pulse">
                      NEW
                    </span>
                  )}
                </button>
                <Tooltip text={lesson.title} sub={`${shortPhaseName(stop.phase)} · ${lesson.tasks.length} task${lesson.tasks.length === 1 ? '' : 's'}`} above={lastRow(i)} />
              </div>

              {/* Task chain below the lesson */}
              {lesson.tasks.length > 0 && (
                <div className="absolute left-1/2 -translate-x-1/2 w-0.5 bg-gray-300 dark:bg-gray-700" style={{ top: LESSON_SIZE / 2, height: TASK_FIRST_DY + (lesson.tasks.length - 1) * TASK_STEP - LESSON_SIZE / 2 }} />
              )}
              {lesson.tasks.map((task, k) => {
                const ts = state.tasks.get(task.id) || 'open';
                const tsel = isSelected('task', task.id);
                return (
                  <div key={task.id} className={`absolute group hover:z-50 ${tsel ? 'z-40' : 'z-10'}`} style={{ left: 0, top: TASK_FIRST_DY + k * TASK_STEP, transform: 'translate(-50%, -50%)' }}>
                    <button
                      type="button"
                      data-road-node={`task-${task.id}`}
                      onClick={() => (ts !== 'locked' || isAdmin) && onOpenTask(task, lesson, stop.phase)}
                      title={task.title}
                      className={`relative flex items-center justify-center rounded-full border-2 shadow-sm transition-transform ${taskClasses(ts, task.type, isAdmin)} ${
                        ts === 'locked' && !isAdmin ? 'cursor-not-allowed' : 'hover:scale-125 cursor-pointer'
                      } ${tsel ? 'ring-4 ring-primary/50 scale-125' : ''}`}
                      style={{ width: TASK_SIZE, height: TASK_SIZE }}
                    >
                      {taskIcon(ts, task.type, isAdmin)}
                      {ts === 'current' && <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping" />}
                      {isAdmin && (task.unviewed_count || 0) > 0 && (
                        <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center border border-white z-10">
                          {task.unviewed_count}
                        </span>
                      )}
                    </button>
                    <Tooltip text={task.title} sub={`${task.type === 'mandatory' ? 'Mandatory' : 'Optional'} · ${task.xp_reward} ★${task.deadline ? ` · due ${new Date(task.deadline).toLocaleDateString()}` : ''}`} above={lastRow(i)} />
                  </div>
                );
              })}
            </div>
          );
        })}

        {stops.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm font-semibold">
            This course has no phases yet.
          </div>
        )}
      </div>
    </div>
  );
};

const Tooltip: React.FC<{ text: string; sub?: string; above?: boolean }> = ({ text, sub, above }) => (
  <div className={`absolute left-1/2 -translate-x-1/2 w-max max-w-[240px] px-3 py-2 rounded-lg bg-gray-900 text-white text-xs shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 ${above ? 'bottom-full mb-2' : 'top-full mt-2'}`}>
    <div className="font-bold leading-snug">{text}</div>
    {sub && <div className="text-gray-300 mt-0.5">{sub}</div>}
  </div>
);

function phaseClasses(status: NodeStatus): string {
  switch (status) {
    case 'locked': return 'bg-gray-100 border-gray-300 text-gray-400 dark:bg-gray-800 dark:border-gray-600';
    case 'completed': return 'bg-green-500 border-green-600 text-white';
    case 'current': return 'bg-primary border-primary-dark text-white';
    default: return 'bg-white border-primary text-primary-dark dark:bg-gray-900 dark:text-primary';
  }
}

function lessonClasses(status: NodeStatus, isAdmin: boolean): string {
  if (isAdmin) return 'bg-blue-50 border-blue-400 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200';
  switch (status) {
    case 'locked': return 'bg-gray-100 border-gray-300 text-gray-400 dark:bg-gray-800 dark:border-gray-600';
    case 'completed': return 'bg-green-500 border-green-600 text-white';
    case 'current': return 'bg-primary border-primary-dark text-white';
    default: return 'bg-white border-primary text-primary-dark dark:bg-gray-900 dark:text-primary';
  }
}

function taskClasses(status: NodeStatus, type: 'mandatory' | 'optional', isAdmin: boolean): string {
  if (!isAdmin) {
    if (status === 'completed') return 'bg-green-50 border-green-400 text-green-600 dark:bg-green-900/40';
    if (status === 'locked') return 'bg-gray-100 border-gray-300 text-gray-400 dark:bg-gray-800 dark:border-gray-600';
    if (status === 'current') return 'bg-primary border-primary-dark text-white';
  }
  return type === 'mandatory'
    ? 'bg-blue-50 border-blue-400 text-blue-500 dark:bg-blue-900/40'
    : 'bg-yellow-50 border-yellow-300 text-yellow-500 dark:bg-yellow-900/30';
}

function taskIcon(status: NodeStatus, type: 'mandatory' | 'optional', isAdmin: boolean) {
  if (!isAdmin) {
    if (status === 'completed') return <span className="material-icons text-base">check</span>;
    if (status === 'locked') return <span className="font-extrabold text-xs">?</span>;
    if (status === 'current') return <span className="material-icons text-sm">flag</span>;
  }
  return <span className="material-icons text-sm">{type === 'mandatory' ? 'assignment' : 'stars'}</span>;
}
