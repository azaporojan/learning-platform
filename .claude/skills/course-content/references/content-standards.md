# Content standards: homework, quizzes, flashcards

These rules come from the teacher's feedback on earlier content. They exist because students are
career-switchers preparing for real employers' entry tests (Endava, Grid Dynamics) and the ISTQB
CTFL exam: anything we teach that differs from industry usage costs them points later.

## Accuracy first

- **Every definition must match the source it claims.** For ISTQB terms, the source is the CTFL v4.0
  syllabus (cite the section, e.g. "§1.2.3") or the ISTQB Glossary (glossary.istqb.org). Quote the
  definition as written; put your simplification in a separate "In simple words" line, never inside
  the quoted definition.
- **Verify before publishing.** Use WebSearch/WebFetch to confirm definitions, numbers, versions,
  and quotes you are not certain of. The sandbox proxy often blocks istqb.org/glossary.istqb.org; if
  so, confirm through two independent mirrors and say so in your report ("confirmed via third-party
  copies of the glossary; official site unreachable from here").
- **Flag the classic traps** in explanations: "QA = tester" (in ISTQB, testing is QC), "testing
  proves there are no defects", "testers debug", "every defect causes a failure", verification vs
  validation. Job-market usage and ISTQB usage sometimes differ; say which is which.
- When the teacher supplies questions, check each answer key against the syllabus. Fix wrong keys and
  ambiguous wording, and tell the user exactly what you changed and why.

## Language and examples

- Student-facing text (tasks, quizzes, flashcards, slide content for students): **plain English, A2–B1**.
  Short sentences, one idea each, common words. Technical terms stay in English (they are what
  interviewers say).
- Examples come from the student's own work whenever possible: their Week-N homework apps
  (Calculator, SimpleInterest, MaxOfThree…), the MyONG project, their GitHub repo. Read the lesson
  script first — it names the examples the teacher uses in class; reuse them so homework, quiz,
  cards and slides tell one story.
- Teacher-facing text (lesson scripts) is in Russian, like the existing scripts.

## Homework tasks

- One task per lesson (`Week N theory homework`, `Week N homework (push to GitHub)`,
  `Week N: Bring 3 questions`), mandatory, deadline = Sunday of that week, ~10–20 stars.
- Description is a Markdown bullet list of concrete deliverables, each checkable by the teacher
  ("score 70%+, attach a screenshot", "paste the PR link", "table with 4 rows"). Mention the quiz or
  flashcards by name when the homework uses them.

## Quizzes (`kind: "quiz"`)

- Usually 10–20 questions, 4 options, one correct (use `correct: [..]` only for genuine
  "select all that apply"). Title: `Self-quiz: ISTQB §X.Y–X.Z (N questions)` or similar.
- Description states the scope, the pass mark (e.g. "14 / 20 (70%)"), "answer from memory first",
  and what to attach to which homework task.
- **Balance answer positions**: each letter correct roughly equally often, in an irregular order.
  A teacher's draft often has the right answer mostly in (b); shuffle and say so.
- **No giveaways**: the correct option must not be systematically the longest or the only precise
  one; write distractors of similar length and specificity. No "all/none of the above".
- **Every question gets an explanation** (shown after grading): why the right answer is right, why
  the tempting wrong one is wrong, and the syllabus section. Students learn most here.
- Write wrong options from real misconceptions, not jokes.
- Run `python3 scripts/check_study_set.py quiz.json` and fix every error and warning (or explain why
  a warning is acceptable) before publishing.

## Flashcards (`kind: "flashcards"`)

- **Front = a question**, varied in form: "What is a **defect**? Name two synonyms.",
  "What is **debugging**, and how is it different from testing?", "Explain in simple terms…".
  Bold the term. If the question asks for extra things (synonyms, a difference), the back must answer them.
- **Back** (Markdown, in this order):
  ```
  **Synonyms:** bug, fault.            ← only when relevant
  **ISTQB definition:** <exact text>   ← or "Syllabus §x.y" wording
  **In simple words:** <1–2 sentences>
  **Example:** <from the student's own work / the lesson's running example>
  ```
- Description says what the deck is for and, when the homework asks for the student's own examples,
  "write your own example, not the one from the card".

## After publishing

Read the set back (`GET /lessons/:id/study-sets`) and report item counts. Report anything you could
not verify, every change you made to teacher-supplied material, and ids (quiz id, flashcards id).
