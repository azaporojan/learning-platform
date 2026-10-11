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
  and quotes you are not certain of. The sandbox often cannot fetch istqb.org or glossary.istqb.org
  (proxy/DNS), and sometimes WebFetch reaches nothing at all. Then verify through WebSearch results
  (ideally two independent ones agreeing) and **label each fact in your report by how it was
  checked**: *official source*, *search results / third-party copies*, or *from memory, unverified*.
  Name the least certain items so the teacher can check them in a minute. Don't present a fact
  checked only from memory as an exact quote.
- **Flag the classic traps** in explanations: "QA = tester" (in ISTQB, testing is QC), "testing
  proves there are no defects", "testers debug", "every defect causes a failure", verification vs
  validation. Job-market usage and ISTQB usage sometimes differ; say which is which.
- When the teacher supplies questions, check each answer key against the syllabus. Fix wrong keys and
  ambiguous wording, and tell the user exactly what you changed and why. **Lesson scripts often end
  with an appendix holding the teacher's quiz draft** (e.g. "Приложение: квиз …"): look for it before
  writing a quiz; it is the teacher's material, so start from it and report your changes.

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

- Question count: what the user asks for; otherwise what the homework task and the script promise
  (usually 10–20). If the user's number differs from what the homework/script say, follow the user
  and offer to update the task text and the script to match (ask before the `PUT`).
- 4 options, one correct (use `correct: [..]` only for genuine
  "select all that apply"). Title: `Self-quiz: ISTQB §X.Y–X.Z (N questions)` or similar.
- Description states the scope, the pass mark (70% rounded up: `ceil(0.7 × n)`, e.g. 14 / 20, 11 / 15, 7 / 10), "answer from memory first",
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
