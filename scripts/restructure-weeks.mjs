#!/usr/bin/env node
// Restructure weeks 1–10 (paths "Phase 1" and "Phase 2") from one node per week into three:
//   Week N — Code (the existing lesson, kept: same id, same homework task and submissions)
//   Week N — Testing theory (new lesson, one mandatory task)
//   Week N — Q&A and review (new lesson, one optional task)
// ISTQB CTFL 4.0 chapters 1–4 are spread over the ten theory lessons; the old optional
// "theory slot" tasks are deleted. Nothing is deleted at lesson level.
//
// Usage:
//   LEARNING_API_URL=https://learning.bsf.md/api LEARNING_API_KEY=lp_… node scripts/restructure-weeks.mjs            # dry run
//   LEARNING_API_URL=https://learning.bsf.md/api LEARNING_API_KEY=lp_… node scripts/restructure-weeks.mjs --apply    # execute
//
// Requires a server that accepts order/x/y/parentId on PUT /lessons/:id (docs/AGENT_API.md);
// the script verifies that on the first move and stops if the server ignored the fields.

const API = (process.env.LEARNING_API_URL || 'https://learning.bsf.md/api').replace(/\/$/, '');
const KEY = process.env.LEARNING_API_KEY;
const APPLY = process.argv.includes('--apply');
if (!KEY && APPLY) { console.error('LEARNING_API_KEY is not set'); process.exit(1); }
// A dry run only reads public endpoints, so it works without a key.

const LAYOUT = { firstX: 80, centerY: 250, lessonSpacingX: 250, firstTaskOffset: 120, taskSpacingX: 150 };

// ---------------------------------------------------------------------------------------------
// Content. `week` matches the "Week N" prefix of the existing lesson titles.
// ---------------------------------------------------------------------------------------------
const WEEKS = [
  { week: 1, deadline: '2026-10-07', path: 'Phase 1',
    code: { title: 'Week 1 — Code: setup, variables and Scanner input' },
    theory: {
      title: 'Week 1 — Testing theory: how computers run programs, Git',
      description: '<p>Computer-science basics for a tester: what a program, a compiler and the JVM are; memory, variables and types; how a console program talks to the OS (educative.io "Beginner\'s guide to computers and programming"). Git workflow: clone, commit, push, branch, pull request, how a reviewer reads a PR.</p>',
      task: { title: 'Week 1 theory homework', description: '<p>Write in your own words (10–15 lines, English): what a program, a compiler, memory and a variable are. Create a branch, change the README, open a pull request to your own repo and merge it. Paste the PR link.</p>' } } },
  { week: 2, deadline: '2026-10-14', path: 'Phase 1',
    code: { title: 'Week 2 — Code: control flow and methods' },
    theory: {
      title: 'Week 2 — Testing theory: ISTQB 1.1–1.2, what testing is and why',
      description: '<p>ISTQB CTFL 4.0 §1.1–1.2: test objectives, testing vs debugging, error → defect → failure, root causes, why testing is necessary, testing and quality assurance.</p>',
      task: { title: 'Week 2 theory homework', description: '<p>20-question self-quiz on §1.1–1.2 (score 70%+, attach a screenshot). Write the definition of testing and of debugging and list 5 differences between them.</p>' } } },
  { week: 3, deadline: '2026-10-21', path: 'Phase 1',
    code: { title: 'Week 3 — Code: arrays and String' },
    theory: {
      title: 'Week 3 — Testing theory: ISTQB 1.3–1.5, principles, activities, skills',
      description: '<p>ISTQB §1.3 the seven testing principles; §1.4 test activities, testware, traceability, roles (test manager / tester); §1.5 essential skills, whole-team approach, independence of testing.</p>',
      task: { title: 'Week 3 theory homework', description: '<p>For each of the seven principles write one real-life example (7 lines, English). 20-question self-quiz on §1.3–1.5 (70%+, screenshot).</p>' } } },
  { week: 4, deadline: '2026-10-28', path: 'Phase 1',
    code: { title: 'Week 4 — Code: collections' },
    theory: {
      title: 'Week 4 — Testing theory: SDLC models and ISTQB 2.1',
      description: '<p>Software development lifecycle: waterfall, V-model, iterative/incremental, agile (tutorialspoint and guru99 SDLC overviews). ISTQB §2.1: testing in the context of an SDLC, shift-left, DevOps, retrospectives.</p>',
      task: { title: 'Week 4 theory homework', description: '<p>Draw the V-model and map every test level to its development phase (photo or diagram). 10 questions on SDLC models. One paragraph: where does a tester work in a scrum sprint?</p>' } } },
  { week: 5, deadline: '2026-11-04', path: 'Phase 1',
    code: { title: 'Week 5 — Code: OOP I, classes and encapsulation' },
    theory: {
      title: 'Week 5 — Testing theory: ISTQB 2.2–2.3, test levels and types',
      description: '<p>ISTQB §2.2 test levels (component, component integration, system, system integration, acceptance) and test types (functional, non-functional, black-box, white-box); confirmation and regression testing. §2.3 maintenance testing.</p>',
      task: { title: 'Week 5 theory homework', description: '<p>Classify 15 given test scenarios by level and type (table). 20-question self-quiz on chapter 2 (70%+, screenshot).</p>' } } },
  { week: 6, deadline: '2026-11-11', path: 'Phase 1',
    code: { title: 'Week 6 — Code: OOP II, inheritance, interfaces, exceptions' },
    theory: {
      title: 'Week 6 — Testing theory: ISTQB chapter 3, static testing and reviews',
      description: '<p>ISTQB §3.1 static testing basics, value of static testing, static vs dynamic; §3.2 feedback and review process, roles, review types (informal, walkthrough, technical review, inspection), success factors. Plus a review of chapter 1 before Phase 2.</p>',
      task: { title: 'Week 6 theory homework', description: '<p>Review your own week-5 BankAccount code with a written checklist and record 5 findings as review comments on GitHub. 20-question quiz covering chapters 1 and 3 (70%+, screenshot).</p>' } } },
  { week: 7, deadline: '2026-11-18', path: 'Phase 2',
    code: { title: 'Week 7 — Code: JUnit 5' },
    theory: {
      title: 'Week 7 — Testing theory: ISTQB 4.1–4.2, black-box techniques',
      description: '<p>ISTQB §4.1 test techniques overview; §4.2 black-box techniques: equivalence partitioning, boundary value analysis (2-value and 3-value), decision table testing, state transition testing. The heaviest part of the exam — on paper, with worked examples.</p>',
      task: { title: 'Week 7 theory homework', description: '<p>15 test cases for a login form and 10 for a transfer-money screen using EP + BVA (name the partitions and boundaries). A decision table for a discount rule. A state diagram and state table for an order (new → paid → shipped → delivered / cancelled).</p>' } } },
  { week: 8, deadline: '2026-11-25', path: 'Phase 2',
    code: {
      title: 'Week 8 — Code: data structures and sorting',
      description: '<p>Stack, Queue, Deque, LinkedList vs ArrayList, recursion; selection sort, insertion sort, binary search; Big-O in one sentence. HackerRank data-structures track, easy problems. (Test-design techniques moved to the theory slot of week 7.)</p>',
      homework: '<p>HackerRank data-structures "easy": 6 problems (arrays, 2D arrays, stack, queue). Implement selection sort, insertion sort and binary search by hand with JUnit tests for each.</p>' },
    theory: {
      title: 'Week 8 — Testing theory: ISTQB 4.3–4.5, white-box, experience-based, collaborative',
      description: '<p>ISTQB §4.3 white-box: statement and branch coverage; §4.4 experience-based: error guessing, exploratory testing, checklist-based testing; §4.5 collaboration-based: user stories, acceptance criteria, ATDD.</p>',
      task: { title: 'Week 8 theory homework', description: '<p>Compute statement and branch coverage of your week-2 FizzBuzz tests by hand and add the missing tests. A 30-minute exploratory session on the-internet.herokuapp.com with a charter and session notes. Write acceptance criteria for a "forgot password" user story. 20-question quiz on chapter 4 (70%+, screenshot).</p>' } } },
  { week: 9, deadline: '2026-12-02', path: 'Phase 2',
    code: { title: 'Week 9 — Code: SQL I' },
    theory: {
      title: 'Week 9 — Testing theory: Scrum Guide end to end',
      description: '<p>The Scrum Guide (scrumguides.org): accountabilities (product owner, scrum master, developers), events (sprint, planning, daily, review, retrospective), artifacts and their commitments (product goal, sprint goal, definition of done). Where testing and bug triage live in a sprint; ISTQB §5.1 test planning in agile in brief.</p>',
      task: { title: 'Week 9 theory homework', description: '<p>10 questions on the Scrum Guide. Write a one-sprint plan for your own study week in scrum terms (goal, backlog items, DoD). One paragraph: what a tester does on each scrum event.</p>' } } },
  { week: 10, deadline: '2026-12-09', path: 'Phase 2',
    code: {
      title: 'Week 10 — Code: SQL II',
      description: '<p>SQL II: <code>JOIN</code> types, subqueries, <code>INSERT/UPDATE/DELETE</code>, primary/foreign keys, what a transaction is. (Bug reports moved to this week\'s theory slot.)</p>',
      homework: '<p>15 join queries against the customers/orders/products schema, each with the expected row count written as a comment.</p>' },
    theory: {
      title: 'Week 10 — Testing theory: bug reports, ISTQB chapter 5 basics and sample exam',
      description: '<p>Bug report writing: title, steps, expected vs actual, environment, severity vs priority, attachments. ISTQB §5.5 defect management and §5.1–5.3 at reading level (test plan, risk, monitoring). Then a timed CTFL 4.0 sample exam, chapters 1–4.</p>',
      task: { title: 'Week 10 theory homework', description: '<p>5 bug reports in English on the-internet.herokuapp.com. The official CTFL 4.0 sample exam A, 40 questions in 60 minutes, score 70%+ (attach the score sheet and your list of wrong answers with the reason for each).</p>' } } },
];

const QA_DESCRIPTION = '<p>Open session: questions from the week, live review of the homework, re-doing the problem that went wrong, mock interview questions on the theory topic.</p>';
const QA_TASK = { title: 'Bring 3 questions', description: '<p>Before the session post 3 questions (code, theory or career) as a submission. Anything counts; "why does my test fail" is the best kind.</p>' };

// ---------------------------------------------------------------------------------------------
async function api(method, pathname, body) {
  const res = await fetch(API + pathname, {
    method,
    headers: { ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${text}`);
  return json;
}

function lessonPos(order) { return { x: LAYOUT.firstX + LAYOUT.lessonSpacingX * (order - 1), y: LAYOUT.centerY }; }
function taskPos(lessonOrder, lesson, index) {
  const direction = lessonOrder % 2 !== 0 ? -1 : 1;
  return { x: lesson.x + LAYOUT.firstTaskOffset + LAYOUT.taskSpacingX * index, y: lesson.y + LAYOUT.firstTaskOffset * direction };
}

const plan = [];   // human-readable log
let writes = 0;
async function write(label, method, pathname, body) {
  plan.push(`${APPLY ? 'DO ' : 'DRY'} ${method} ${pathname}  ${label}`);
  writes++;
  if (!APPLY) return { id: -writes };
  return api(method, pathname, body);
}

async function main() {
  const paths = await api('GET', '/paths');
  const byPrefix = (prefix) => paths.find((p) => p.title.startsWith(prefix));
  const phase1 = byPrefix('Phase 1'), phase2 = byPrefix('Phase 2');
  if (!phase1 || !phase2) throw new Error('Phase 1 / Phase 2 paths not found');

  for (const [pathLabel, path] of [['Phase 1', phase1], ['Phase 2', phase2]]) {
    const details = await api('GET', `/paths/${path.id}/details`);
    const weeks = WEEKS.filter((w) => w.path === pathLabel);
    if (details.length !== weeks.length) throw new Error(`${pathLabel}: expected ${weeks.length} lessons (one per week), found ${details.length} — already restructured?`);

    let order = 1;
    let parentId = null;
    for (const w of weeks) {
      const existing = details.find((l) => new RegExp(`^Week ${w.week}\\b`).test(l.title));
      if (!existing) throw new Error(`${pathLabel}: no lesson titled "Week ${w.week}…"`);

      // 1. Code lesson: keep the node, rename, move to order 3k-2
      const codeOrder = order++;
      const codePos = lessonPos(codeOrder);
      await write(`rename+move "${existing.title}" → "${w.code.title}" (order ${codeOrder})`, 'PUT', `/lessons/${existing.id}`, {
        title: w.code.title, description: w.code.description ?? existing.description ?? '', order: codeOrder, ...codePos, parentId,
      });
      if (APPLY && order === 2) {
        const check = await api('GET', `/paths/${path.id}/details`);
        const moved = check.find((l) => l.id === existing.id);
        if (!moved || moved.position_x !== codePos.x) throw new Error('Server ignored order/x/y on PUT /lessons — deploy the API change first');
      }
      // Homework task stays (same id, same submissions); re-position under the moved lesson.
      const tasks = [...existing.tasks].sort((a, b) => a.order_index - b.order_index);
      const homework = tasks.find((t) => t.type === 'mandatory');
      const theorySlot = tasks.filter((t) => t.type === 'optional' && /theory slot/i.test(t.title));
      if (homework) {
        const pos = taskPos(codeOrder, codePos, 0);
        await write(`move homework task "${homework.title}"`, 'PUT', `/tasks/${homework.id}`, {
          title: homework.title, type: homework.type, xp: homework.xp_reward, deadline: homework.deadline,
          description: w.code.homework ?? homework.description ?? '', order: 1, ...pos,
        });
      }
      for (const t of theorySlot) await write(`delete old optional task "${t.title}"`, 'DELETE', `/tasks/${t.id}`);
      parentId = existing.id;

      // 2. Theory lesson (new) with one mandatory task
      const theoryOrder = order++;
      const theoryPos = lessonPos(theoryOrder);
      const theory = await write(`create "${w.theory.title}" (order ${theoryOrder})`, 'POST', '/lessons', {
        pathId: Number(path.id), title: w.theory.title, description: w.theory.description, order: theoryOrder, ...theoryPos, parentId,
      });
      const tp = taskPos(theoryOrder, theoryPos, 0);
      await write(`  + mandatory task "${w.theory.task.title}"`, 'POST', '/tasks', {
        lessonId: theory.id, title: w.theory.task.title, type: 'mandatory', xp: 15, deadline: w.deadline, order: 1, description: w.theory.task.description, ...tp,
      });
      parentId = theory.id;

      // 3. Q&A lesson (new) with one optional task — no mandatory task, so it never blocks the chain
      const qaOrder = order++;
      const qaPos = lessonPos(qaOrder);
      const qa = await write(`create "Week ${w.week} — Q&A and review" (order ${qaOrder})`, 'POST', '/lessons', {
        pathId: Number(path.id), title: `Week ${w.week} — Q&A and review`, description: QA_DESCRIPTION, order: qaOrder, ...qaPos, parentId,
      });
      const qp = taskPos(qaOrder, qaPos, 0);
      await write(`  + optional task "${QA_TASK.title}"`, 'POST', '/tasks', {
        lessonId: qa.id, title: `Week ${w.week}: ${QA_TASK.title}`, type: 'optional', xp: 5, deadline: w.deadline, order: 1, description: QA_TASK.description, ...qp,
      });
      parentId = qa.id;
    }
  }

  console.log(plan.join('\n'));
  console.log(`\n${APPLY ? 'Applied' : 'Dry run:'} ${writes} write${writes === 1 ? '' : 's'}${APPLY ? '' : ' (re-run with --apply to execute)'}.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
