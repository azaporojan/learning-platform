---
name: course-content
description: Create and publish teaching content on the Learning Platform (learning.bsf.md, the "QA Automation Engineer" course) through its admin API — new phases and lessons, homework tasks, quizzes, flashcard decks, Russian lesson scripts for the teacher, and lesson presentation decks (PDF with diagrams, icons, quotes and linked industry standards such as ISTQB, ISO/IEC/IEEE 29119, Scrum Guide). Use this whenever the user mentions a lesson, week, phase, homework, quiz, flashcards, lesson script/сценарий, slides/deck/презентация for the course, ISTQB material for students, or asks to add, fix, review or attach anything on learning.bsf.md — even if they don't say "skill" or "API".
---

# Course content for the Learning Platform

You are helping Alex, who teaches a 1:1 "QA Automation Engineer" course (Java, ISTQB CTFL v4.0,
JUnit, SQL, Selenium, Cucumber, REST Assured) to career-switchers aiming at entry tests at Endava and
Grid Dynamics. The platform (this repository) shows a course as a road of phases → lessons → tasks,
with quizzes and flashcards under lessons and attached PDFs. Students follow it daily, so whatever you
publish is seen immediately and must be correct by industry standards — wrong definitions cost them
exam and interview points later.

## Before anything

1. API access: `LEARNING_API_KEY` must be set (it usually is; `LEARNING_API_URL` defaults to
   `https://learning.bsf.md/api`). Never print the key.
2. Look at the current state — ids, titles, what already exists:
   ```bash
   node .claude/skills/course-content/scripts/lp.mjs tree 1
   ```
3. Read the lesson's script (`lp.mjs script-get <lessonId> /tmp/…/script.md`) and its homework task
   (`lp.mjs get /tasks/<id>`, id from the tree). Scripts are long; search them for the block
   headings, the homework section and the appendix (a quiz draft often lives there). The script names the examples, the homework, and the exact topics;
   everything you make for that lesson should tell the same story.

Read `references/platform-api.md` for the endpoints and the traps (several calls destroy student
results or email students). `docs/AGENT_API.md` is the full API reference.

## What to read for each kind of request

| Request | Read | Then |
|---|---|---|
| New phase / lessons / reorder | `references/platform-api.md`, `references/lesson-script-template.md` (course rhythm, title patterns) | Prefer `POST /admin/paths/import` (one transaction, no student emails). Show the user the planned titles/dates before creating a whole phase. |
| Homework task | `references/content-standards.md` § Homework | `GET /tasks/:id` before `PUT`; keep the script's homework section in sync |
| Quiz / flashcards | `references/content-standards.md` | Check the script's appendix for a teacher draft → draft JSON → `scripts/check_study_set.py` → verify facts → `POST /study-sets` → read back |
| Lesson script | `references/lesson-script-template.md` + one neighbouring script | Russian, minute-by-minute; save with `lp.mjs script-put` (it refuses to overwrite a newer copy) |
| Presentation | `references/presentations.md`, `references/industry-sources.md` | Build with `scripts/build_deck.mjs`, look at every slide, verify links, send the PDF; upload when asked |

## Working principles

- **Correctness over speed.** Check definitions against the ISTQB syllabus / glossary or the
  official docs listed in `references/industry-sources.md`, using WebSearch/WebFetch when unsure.
  When the teacher gives you material (a quiz draft, a term list), check it the same way and report
  every correction. When a source can't be reached from the sandbox, say how you verified instead.
- **Simple English for students, Russian for the teacher.** Student-facing text is A2–B1 English;
  lesson scripts and (by default) slide text are Russian with English terms, like the existing ones.
- **One running example per lesson**, preferably the student's own homework code, reused across
  the quiz, flashcards, homework and slides.
- **Live system, real students.** Creating is fine when asked. Ask first before anything that deletes,
  rewrites quiz/flashcard items students may already have results on, or emails students in bulk
  (many `POST /tasks`). Never delete-and-recreate lessons to reorder them.
- **Show, then publish, for big changes.** For a new phase or a full week, outline titles, dates and
  task names to the user first. For a single quiz/deck the user asked for, publish directly and
  report.
- **Close the loop.** After writing, read it back from the API, and report ids, counts, links, and
  anything you changed or could not verify.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/lp.mjs` | API helper: `tree`, `get/post/put/delete`, `script-get/script-put`, `upload` |
| `scripts/check_study_set.py` | Validates quiz/flashcard JSON: API limits + course quality rules (answer balance, giveaway options, explanations, question-form fronts, examples) |
| `scripts/build_deck.mjs` | Slide HTML → PDF with the course theme, local fonts, Lucide icons, Mermaid diagrams, footers; reports overflow and lists links; `--sheet`/`--png` previews. Needs `npm install --prefix .claude/skills/course-content/scripts` once |

Use the user's scratchpad / a temp directory for drafts (JSON, scripts, decks); nothing you draft
for publishing belongs in the git repository.
