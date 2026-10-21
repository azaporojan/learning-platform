import type { CourseDetail, Phase, RoadLesson, RoadStudySet, RoadTask } from './types';

// Per-node status on the course road, derived once from GET /courses/:id and shared by the
// tree pane and the map.
//   completed — done (X on the map)
//   current   — the next thing to do (flag)
//   open      — reachable but not the next thing (e.g. an optional task, a lesson without tasks)
//   locked    — not reached yet (?) or behind a phase gate
export type NodeStatus = 'completed' | 'current' | 'open' | 'locked';

// Admin only: teaching progress over the whole course, from the lessons marked as taught.
//   done     — taught (not the latest one)
//   previous — the last taught lesson before the current one
//   current  — the first lesson not taught yet
//   next     — the lesson after the current one
export type TeachStatus = 'done' | 'previous' | 'current' | 'next';

export interface RoadState {
  lessons: Map<number, NodeStatus>;
  tasks: Map<number, NodeStatus>;
  studySets: Map<number, NodeStatus>;
  phases: Map<number, NodeStatus>;
  currentPhaseId: number | null;
  currentLessonId: number | null;
  currentTaskId: number | null;
  teach: Map<number, TeachStatus>;
}

export const studySetMastered = (set: RoadStudySet) =>
  set.progress !== null && set.item_count > 0 && set.progress.total === set.item_count && set.progress.best_score >= set.item_count;

const mandatoryDone = (lesson: RoadLesson) => lesson.tasks.filter((t) => t.type === 'mandatory').every((t) => t.completed);
// Optional tasks never gate anything: a lesson "has work left" only while a mandatory task is
// open; a lesson with optional tasks only has work left until they are all done.
const hasWorkLeft = (lesson: RoadLesson) => {
  const mandatory = lesson.tasks.filter((t) => t.type === 'mandatory');
  if (mandatory.length > 0) return mandatory.some((t) => !t.completed);
  return lesson.tasks.some((t) => !t.completed);
};

export function computeRoadState(course: CourseDetail, isAdmin: boolean): RoadState {
  const state: RoadState = {
    lessons: new Map(),
    tasks: new Map(),
    studySets: new Map(),
    phases: new Map(),
    currentPhaseId: null,
    currentLessonId: null,
    currentTaskId: null,
    teach: new Map(),
  };

  // "You are here": the first reachable lesson with a mandatory task still open; failing that,
  // the first reachable lesson with any task still open (e.g. an optional-only lesson).
  let fallbackLessonId: number | null = null;
  let fallbackPhaseId: number | null = null;

  for (const phase of course.phases) {
    let previousIncomplete = false;
    let phaseAllDone = phase.lessons.length > 0;

    for (const lesson of phase.lessons) {
      // An admin unlock opens the lesson even when the phase or the previous lesson is not done
      const lessonLocked = !isAdmin && !lesson.unlocked && (phase.locked || previousIncomplete);
      const mandatoryLeft = lesson.tasks.some((t) => t.type === 'mandatory' && !t.completed);
      let lessonStatus: NodeStatus;
      if (isAdmin) {
        lessonStatus = 'open';
      } else if (lesson.completed) {
        lessonStatus = 'completed';
      } else if (lessonLocked) {
        lessonStatus = 'locked';
      } else if (state.currentLessonId === null && mandatoryLeft) {
        lessonStatus = 'current';
        state.currentLessonId = lesson.id;
        state.currentPhaseId = phase.id;
      } else {
        lessonStatus = 'open';
        if (fallbackLessonId === null && hasWorkLeft(lesson)) { fallbackLessonId = lesson.id; fallbackPhaseId = phase.id; }
      }
      state.lessons.set(lesson.id, lessonStatus);
      if (!lesson.completed) phaseAllDone = false;

      // Inside a lesson, tasks open in order — but only a mandatory task holds the next one
      // back; an optional task that is skipped never blocks the homework after it.
      let previousMandatoryOpen = false;
      lesson.tasks.forEach((task: RoadTask) => {
        const taskLocked = !isAdmin && (lessonLocked || previousMandatoryOpen);
        let taskStatus: NodeStatus;
        if (isAdmin) {
          taskStatus = 'open';
        } else if (task.completed) {
          taskStatus = 'completed';
        } else if (taskLocked) {
          taskStatus = 'locked';
        } else if (lessonStatus === 'current' && state.currentTaskId === null && task.type === 'mandatory') {
          taskStatus = 'current';
          state.currentTaskId = task.id;
        } else {
          taskStatus = 'open';
        }
        state.tasks.set(task.id, taskStatus);
        if (task.type === 'mandatory' && !task.completed) previousMandatoryOpen = true;
      });

      // Quizzes / flashcards open with their lesson and never gate anything; "completed" = a
      // perfect best result on the current version of the set.
      (lesson.study_sets || []).forEach((set) => {
        let st: NodeStatus;
        if (isAdmin) st = 'open';
        else if (studySetMastered(set)) st = 'completed';
        else if (lessonLocked) st = 'locked';
        else st = 'open';
        state.studySets.set(set.id, st);
      });

      if (!mandatoryDone(lesson)) previousIncomplete = true;
    }

    let phaseStatus: NodeStatus;
    if (isAdmin) phaseStatus = 'open';
    else if (phase.locked) phaseStatus = 'locked';
    else if (phaseAllDone) phaseStatus = 'completed';
    else if (state.currentPhaseId === phase.id) phaseStatus = 'current';
    else phaseStatus = 'open';
    state.phases.set(phase.id, phaseStatus);
  }

  if (!isAdmin && state.currentLessonId === null && fallbackLessonId !== null) {
    state.currentLessonId = fallbackLessonId;
    state.currentPhaseId = fallbackPhaseId;
    state.lessons.set(fallbackLessonId, 'current');
    const lesson = course.phases.flatMap((p) => p.lessons).find((l) => l.id === fallbackLessonId)!;
    const next = lesson.tasks.find((t) => !t.completed && state.tasks.get(t.id) === 'open');
    if (next) { state.tasks.set(next.id, 'current'); state.currentTaskId = next.id; }
    if (state.phases.get(fallbackPhaseId!) === 'open') state.phases.set(fallbackPhaseId!, 'current');
  }

  if (isAdmin) state.teach = computeTeachState(course);
  return state;
}

export function computeTeachState(course: CourseDetail): Map<number, TeachStatus> {
  const teach = new Map<number, TeachStatus>();
  const lessons = course.phases.flatMap((p) => p.lessons);
  const current = lessons.findIndex((l) => !l.taught_at);
  lessons.forEach((l) => { if (l.taught_at) teach.set(l.id, 'done'); });
  if (current === -1) return teach; // everything taught
  if (current > 0) teach.set(lessons[current - 1].id, 'previous');
  teach.set(lessons[current].id, 'current');
  const next = lessons.findIndex((l, i) => i > current && !l.taught_at);
  if (next !== -1) teach.set(lessons[next].id, 'next');
  return teach;
}

// "Phase 3 — Selenium, Page Objects…" → "Phase 3"; otherwise a short prefix of the name.
export function shortPhaseName(phase: Phase): string {
  const m = phase.name.match(/^(phase|faza|etapa|level|stage|week|part)\s*\d+/i);
  if (m) return m[0];
  return phase.name.length > 18 ? `${phase.name.slice(0, 16)}…` : phase.name;
}

export function lockReasonText(phase: Phase, previous: Phase | null): string {
  const parts: string[] = [];
  if (phase.lockReasons.includes('unpublished')) parts.push('Not published yet');
  if (phase.lockReasons.includes('enroll')) parts.push('Enrol in the course to start');
  if (phase.lockReasons.includes('previous')) parts.push(previous ? `Finish ${shortPhaseName(previous)} first` : 'Finish the previous phase first');
  if (phase.lockReasons.includes('stars')) parts.push(`Needs ${phase.stars_required} stars`);
  return parts.join(' · ');
}
