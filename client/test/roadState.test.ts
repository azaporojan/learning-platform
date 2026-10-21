// Course road status (roadState.ts): what is locked, current and open for a student
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRoadState } from '../roadState.ts';
import type { CourseDetail, RoadTask } from '../types.ts';

let nextId = 1;
const task = (type: 'mandatory' | 'optional', completed = false): RoadTask =>
  ({ id: nextId++, lesson_id: 0, title: `t${nextId}`, type, xp_reward: 5, order_index: nextId, position_x: 0, position_y: 0, completed } as RoadTask);

const course = (lessonsPerPhase: { tasks: RoadTask[]; unlocked?: boolean }[][], locked: boolean[] = []): CourseDetail => ({
  id: 1, name: 'C', description: '', enrolled: true,
  phases: lessonsPerPhase.map((lessons, pi) => ({
    id: 100 + pi, name: `Phase ${pi + 1}`, description: '', order_index: pi + 1, stars_required: 0, requires_previous: true,
    locked: locked[pi] || false, lockReasons: locked[pi] ? ['previous'] : [],
    lessons: lessons.map((l, li) => {
      const mandatory = l.tasks.filter((t) => t.type === 'mandatory');
      const completed = l.tasks.length > 0 && (mandatory.length > 0 ? mandatory.every((t) => t.completed) : l.tasks.every((t) => t.completed));
      return { id: 1000 + pi * 10 + li, path_id: 100 + pi, title: `L${li + 1}`, order_index: li + 1, position_x: 0, position_y: 0, completed, unlocked: l.unlocked, tasks: l.tasks, study_sets: [] };
    }),
  })),
});

test('an open optional task does not block the homework after it, nor the next lesson', () => {
  const optional = task('optional');
  const homework = task('mandatory');
  const nextLessonTask = task('mandatory');
  const state = computeRoadState(course([[{ tasks: [optional, homework] }, { tasks: [nextLessonTask] }]]), false);
  assert.equal(state.tasks.get(optional.id), 'open');
  assert.equal(state.tasks.get(homework.id), 'current');
  assert.equal(state.currentTaskId, homework.id);
  assert.equal(state.lessons.get(1001), 'locked'); // the mandatory homework is still open
  const done = computeRoadState(course([[{ tasks: [optional, { ...homework, completed: true }] }, { tasks: [nextLessonTask] }]]), false);
  assert.equal(done.lessons.get(1000), 'completed');
  assert.equal(done.lessons.get(1001), 'current');
  assert.equal(done.tasks.get(nextLessonTask.id), 'current');
  assert.equal(done.tasks.get(optional.id), 'open'); // still there to do, never required
});

test('a mandatory task still holds back the task after it', () => {
  const first = task('mandatory');
  const second = task('mandatory');
  const state = computeRoadState(course([[{ tasks: [first, second] }]]), false);
  assert.equal(state.tasks.get(first.id), 'current');
  assert.equal(state.tasks.get(second.id), 'locked');
});

test('a lesson with only optional tasks never blocks the next lesson', () => {
  const questions = task('optional');
  const homework = task('mandatory');
  const state = computeRoadState(course([[{ tasks: [questions] }, { tasks: [homework] }]]), false);
  assert.equal(state.lessons.get(1000), 'open');
  assert.equal(state.lessons.get(1001), 'current');
  assert.equal(state.tasks.get(homework.id), 'current');
  assert.equal(state.tasks.get(questions.id), 'open');
});

test('when only optional work is left, "you are here" points at it', () => {
  const questions = task('optional');
  const state = computeRoadState(course([[{ tasks: [questions] }]]), false);
  assert.equal(state.currentLessonId, 1000);
  assert.equal(state.tasks.get(questions.id), 'current');
  assert.equal(state.phases.get(100), 'current');
});

test('an admin unlock opens a lesson behind an unfinished lesson or phase', () => {
  const pending = task('mandatory');
  const later = task('mandatory');
  const inLockedPhase = task('mandatory');
  const state = computeRoadState(course([
    [{ tasks: [pending] }, { tasks: [later], unlocked: true }],
    [{ tasks: [inLockedPhase], unlocked: true }],
  ], [false, true]), false);
  assert.equal(state.lessons.get(1000), 'current');
  assert.equal(state.lessons.get(1001), 'open');
  assert.equal(state.tasks.get(later.id), 'open');
  assert.equal(state.phases.get(101), 'locked');
  assert.equal(state.lessons.get(1010), 'open');
  assert.equal(state.tasks.get(inLockedPhase.id), 'open');
  // Without the unlock they stay locked
  const plain = computeRoadState(course([[{ tasks: [pending] }, { tasks: [later] }], [{ tasks: [inLockedPhase] }]], [false, true]), false);
  assert.equal(plain.lessons.get(1001), 'locked');
  assert.equal(plain.lessons.get(1010), 'locked');
});

test('admins see everything open', () => {
  const state = computeRoadState(course([[{ tasks: [task('mandatory')] }], [{ tasks: [task('mandatory')] }]], [false, true]), true);
  assert.ok([...state.lessons.values()].every((s) => s === 'open'));
  assert.ok([...state.phases.values()].every((s) => s === 'open'));
});
