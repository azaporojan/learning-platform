#!/usr/bin/env node
// Roadmap v2 for the "QA Automation Engineer" course: three sessions a week from week 2 on.
//   Mon — Theory (60 min)      task: theory homework, mandatory, due Sunday
//   Wed — Live coding (90 min)  task: code homework, mandatory, due next Tuesday
//   Sat — Q&A / mock interview  task: optional, due the same Saturday
// Weeks run Monday–Sunday from 12 Oct 2026; week 1 (1–7 Oct) is left exactly as it is.
// Weeks 12–13 are holiday-light (no Saturday session); week 19 has Monday and Wednesday only.
// MyONG (Jira project MYONG, dev environment with mock data) is the practice ground for test cases
// from week 3, bug reports from week 10 and the portfolio framework from week 14.
//
// Existing lessons and tasks are updated in place (same ids, submissions kept); missing ones are created.
//
// Usage:
//   LEARNING_API_URL=https://learning.bsf.md/api LEARNING_API_KEY=lp_… node scripts/roadmap-v2.mjs           # dry run
//   LEARNING_API_URL=https://learning.bsf.md/api LEARNING_API_KEY=lp_… node scripts/roadmap-v2.mjs --apply   # execute

const API = (process.env.LEARNING_API_URL || 'https://learning.bsf.md/api').replace(/\/$/, '');
const KEY = process.env.LEARNING_API_KEY;
const APPLY = process.argv.includes('--apply');
if (!KEY) { console.error('LEARNING_API_KEY is not set'); process.exit(1); }

const LAYOUT = { firstX: 80, centerY: 250, lessonSpacingX: 250, firstTaskOffset: 120, taskSpacingX: 150 };
const LAST_DAY = '2027-02-10';

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------
const day = (iso, plus) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + plus); return d.toISOString().slice(0, 10); };
const label = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
const cap = (iso) => (iso > LAST_DAY ? LAST_DAY : iso);
const deadline = (iso) => `${cap(iso)}T23:59:59.000Z`;
const monday = (week) => day('2026-10-12', 7 * (week - 2));

// ---------------------------------------------------------------------------------------------
// Content. html() keeps the descriptions readable here.
// ---------------------------------------------------------------------------------------------
const p = (s) => `<p>${s}</p>`;
const ul = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const RULES = p('Rules: no AI while solving; one commit per program; every program has a test-case table (EP/BVA: # | technique | input | expected) in a comment above the class. Submit the pull request link.');
const QA_TASK = (week, extra = '') => ({
  title: `Week ${week}: Bring 3 questions`,
  description: p('Before the session post 3 questions as a submission: code, theory or career. "Why does my test fail" is the best kind.') + extra,
});
const JIRA = 'MyONG Jira (project MYONG, label <code>qa-training</code>, dev environment with mock data only)';

const WEEKS = [
  { week: 2,
    theory: { title: 'ISTQB 1.1–1.2, what testing is and why',
      description: p('ISTQB CTFL 4.0 §1.1–1.2: test objectives, testing vs debugging, error → defect → failure, root causes, why testing is necessary, testing vs quality assurance.'),
      task: ul(['Read ISTQB CTFL 4.0 §1.1–1.2.', 'Flashcards: add 10 ISTQB glossary terms to your README (testing, debugging, test object, test basis, error, defect, failure, root cause, quality assurance, quality control) — English definition + your own example.', 'Write 3 chains "error → defect → failure" from real life (English, 2–3 lines each).', 'Self-quiz on §1.1–1.2 (20 questions), score 70%+, attach a screenshot.', 'Optional: TAU Java Programming, chapters on decisions and loops.']) },
    code: { title: 'control flow, methods, branch and pull request',
      description: p('if / else if / switch, for, while, do-while, break/continue; methods with parameters and return values. Git: feature branch → pull request → review → merge.'),
      task: ul(['Branch <code>week-2</code> in <code>java-basics</code>, open a pull request to <code>main</code>.', 'Programs: <code>FizzBuzz</code>, <code>MultiplicationTable</code>, <code>GradeCalculator</code> (method <code>grade(int score)</code>), <code>PrimeChecker</code> (method <code>isPrime(int n)</code>), <code>SumOfDigits</code>.', 'Each one with its test-case table; fix every review comment and push again.']) + RULES },
    qa: { focus: 'review of the open pull request; 5 interview questions on §1.1–1.2; 2-minute English explanation of one program.' } },

  { week: 3,
    theory: { title: 'ISTQB 1.3–1.5, principles, activities, testware; test cases in Jira',
      description: p('§1.3 seven principles; §1.4 test activities, testware, traceability, roles; §1.5 skills, whole-team approach, independence. Test case anatomy in Jira: preconditions, steps, expected result, priority, link to the story.'),
      task: ul(['Seven principles: one real example each (English).', 'Self-quiz on §1.3–1.5 (20 questions), 70%+, screenshot.', `<b>${JIRA}:</b> write your first 5 test cases (issue type <i>Test Case</i>) for the story Alex assigns; link each to the story ("relates to"). Paste the Jira filter link.`]) },
    code: { title: 'arrays, String, sorting and binary search; paper coding',
      description: p('Arrays, for-each, String methods (<code>charAt</code>, <code>substring</code>, <code>indexOf</code>, <code>split</code>, <code>equals</code> vs <code>==</code>), <code>StringBuilder</code>; bubble sort and binary search; first problem on paper.'),
      task: ul(['5 w3resource Java String exercises (numbers given in the session).', '<code>ReverseWords</code>, <code>Palindrome</code>, <code>CountVowels</code>, <code>BubbleSort</code>, <code>BinarySearch</code>.', 'One of them solved on paper first: photo in the pull request.']) + RULES },
    qa: { focus: 'review; principles interview round ("give an example of the pesticide paradox"); one String problem on paper in 10 minutes.' } },

  { week: 4,
    theory: { title: 'SDLC models and ISTQB 2.1',
      description: p('SDLC: waterfall, V-model, iterative/incremental, agile (tutorialspoint and guru99 SDLC overviews). ISTQB §2.1: testing in an SDLC, TDD/ATDD/BDD, DevOps, shift-left, retrospectives.'),
      task: ul(['Draw the V-model and map every test level to its development phase (photo).', '10 questions on SDLC models (sheet from Alex).', 'One paragraph in English: where does a tester work in a Scrum sprint?', 'Optional: TAU Java Programming, collections chapter.']) },
    code: { title: 'collections: List, Map, Set, Deque, Comparator',
      description: p('<code>ArrayList</code>, <code>HashMap</code>, <code>HashSet</code>, <code>ArrayDeque</code> as stack and queue, <code>LinkedList</code> vs <code>ArrayList</code>, iteration, sorting with <code>Comparator</code>.'),
      task: ul(['<code>WordFrequency</code>, <code>RemoveDuplicates</code>, <code>BracketValidator</code> (with a Deque), <code>StudentRanking</code> (sort by grade, then name).', '2 easy problems from HackerRank "Data Structures" — links in the pull request.']) + RULES },
    qa: { focus: 'review; SDLC/V-model interview round; collections questions (List vs Set, when HashMap).' } },

  { week: 5,
    theory: { title: 'ISTQB 2.2–2.3, test levels and test types',
      description: p('§2.2 test levels (component, component integration, system, system integration, acceptance) and types (functional, non-functional, black-box, white-box); confirmation vs regression testing. §2.3 maintenance testing.'),
      task: ul(['Classify the 15 scenarios from Alex by level and type (table).', 'Self-quiz on chapter 2 (20 questions), 70%+, screenshot.', `<b>${JIRA}:</b> add level and type to each of your test cases; add 3 non-functional test cases (performance, usability/accessibility, security).`, 'Optional: TAU Java Programming, objects and classes.']) },
    code: { title: 'OOP I: classes, encapsulation, equals/hashCode/toString',
      description: p('Classes and objects, constructors, <code>private</code> fields with validating setters, <code>static</code>, <code>this</code>, <code>equals</code>/<code>hashCode</code>/<code>toString</code>.'),
      task: ul(['<code>Product</code>, <code>BankAccount</code> (deposit/withdraw with validation), <code>Student</code>, plus a <code>Main</code> that uses them.', 'A test-case table for every validating method (valid and invalid partitions).']) + RULES },
    qa: { focus: 'review; "test levels vs test types" interview round; explain encapsulation on your own class in English.' } },

  { week: 6,
    theory: { title: 'ISTQB chapter 3, static testing and reviews; chapter 1 recap',
      description: p('§3.1 static testing basics, value, static vs dynamic; §3.2 feedback and review process, roles, review types (informal, walkthrough, technical review, inspection), success factors.'),
      task: ul(['Review the flawed requirement from Alex: list every defect as a review comment.', 'Self-quiz on chapter 3 (20 questions), 70%+, screenshot.', `<b>${JIRA}:</b> static review of one "Ready" story — leave comments on ambiguities and missing cases in the story.`, 'Optional: TAU Java Programming, inheritance, polymorphism, exceptions.']) },
    code: { title: 'OOP II: inheritance, polymorphism, interfaces, exceptions',
      description: p('Inheritance, method overriding, polymorphism, abstract classes, interfaces; exceptions: checked vs unchecked, <code>try/catch/finally</code>, custom exceptions.'),
      task: ul(['<code>Payment</code> hierarchy (<code>CardPayment</code>, <code>BankTransfer</code>) behind an interface or abstract class.', '<code>InvalidAmountException</code> thrown for invalid input; the test-case table has invalid partitions that expect the exception.', '<code>Shape</code> hierarchy with <code>area()</code>.']) + RULES },
    qa: { focus: '<b>Checkpoint 1:</b> four OOP pillars in English on your own code; one Java problem unaided in 30 minutes; chapters 1–3 quiz 65%+.' } },

  { week: 7,
    theory: { title: 'ISTQB 4.1–4.2: equivalence partitioning, boundary values, decision tables',
      description: p('§4.1 test techniques; §4.2.1 equivalence partitioning, §4.2.2 boundary value analysis (2-value and 3-value), §4.2.3 decision table testing. On paper, with worked examples.'),
      task: ul(['10 technique exercises on paper (sheet from Alex).', `<b>${JIRA}:</b> test cases for the public 230 form fields (CNP, name, email, phone) designed with EP and BVA — technique in each test case; one decision table for the consent options.`]) },
    code: { title: 'JUnit 5: from test-case table to @ParameterizedTest',
      description: p('Maven <code>pom.xml</code>, JUnit 5 (Jupiter), <code>@Test</code>, <code>assertEquals</code>/<code>assertThrows</code>, <code>@BeforeEach</code>, <code>@DisplayName</code>, <code>@ParameterizedTest</code> + <code>@CsvSource</code>, <code>mvn test</code>.'),
      task: ul(['Turn <code>java-basics</code> into a Maven project.', 'JUnit tests for your week 5–6 classes, written from your EP/BVA/decision tables; at least one negative test per method.', 'Everything green with <code>mvn test</code>.']) + RULES },
    qa: { focus: 'review; "how would you test a field that accepts age 18–65" round; boundary counting drill; one logic puzzle.' } },

  { week: 8,
    theory: { title: 'ISTQB 4.2.4–4.5: state transitions, coverage, experience-based, collaboration',
      description: p('§4.2.4 state transition testing; §4.3 statement and branch coverage; §4.4 error guessing, exploratory and checklist-based testing; §4.5 user stories, acceptance criteria, ATDD.'),
      task: ul(['State diagram and coverage exercises (sheet from Alex).', 'Self-quiz on chapter 4 (20 questions), 70%+, screenshot.', `<b>${JIRA}:</b> state transition table for the donor reminder lifecycle (including STOP opt-out) and test cases for valid and invalid transitions.`]) },
    code: { title: 'data structures in practice: bounded queue, state transitions, coverage',
      description: p('A bounded queue on an array; its states and transitions as tests; statement and branch coverage in IntelliJ; recursion; Big-O in one sentence.'),
      task: ul(['<code>BoundedStack</code> with tests at 100% branch coverage (screenshot of the coverage report).', '<code>factorial</code> and <code>fibonacci</code> recursively, with tests.', '2 easy HackerRank "Data Structures" problems.']) + RULES },
    qa: { focus: 'review; chapter 4 interview round; one logic puzzle; English: explain your state diagram.' } },

  { week: 9,
    theory: { title: 'Scrum Guide and what a database is',
      description: p('The Scrum Guide 2020: accountabilities, events, artifacts and commitments (product goal, sprint goal, definition of done). Databases: DBMS, table, row, column, primary and foreign key.'),
      task: ul(['Read the Scrum Guide 2020 end to end; one-page summary in English.', 'Scrum self-quiz (20 questions), 70%+, screenshot.', `<b>${JIRA}:</b> map the MYONG board statuses to Scrum and write where testing happens; propose one Definition of Done line about testing.`]) },
    code: { title: 'SQL I: SELECT … GROUP BY … HAVING',
      description: p('SQLite + DB Browser for SQLite. <code>SELECT</code>, <code>WHERE</code> (AND/OR/NOT, <code>IN</code>, <code>BETWEEN</code>, <code>LIKE</code>, <code>IS NULL</code>), <code>DISTINCT</code>, aliases, <code>ORDER BY</code>, <code>LIMIT</code>, aggregates, <code>GROUP BY</code>, <code>HAVING</code>.'),
      task: ul(['15 queries on the shop database in <code>queries.sql</code> (new folder <code>sql/</code> in your repo).', 'Above every query: a comment with the expected number of rows — your expected result.']) + p('Rules: no AI while solving. Submit the pull request link.') },
    qa: { focus: 'review; Scrum interview round ("who decides what goes into the sprint?"); 3 SQL queries on paper.' } },

  { week: 10,
    theory: { title: 'bug reports, defect lifecycle, first test cycle on MyONG',
      description: p('Bug report anatomy: title, environment, steps, expected vs actual, severity vs priority, attachments. Defect lifecycle; ISTQB §5.5 defect management. Test cycle: execute, record, report.'),
      task: ul([`<b>${JIRA}:</b> create a Task "Test cycle W10 — &lt;story&gt;", run your test cases on dev, record Pass/Fail per test case in it, file every failure as a Bug (template from the session) linked to the test case and the story.`, 'At least 3 bug reports in total (MyONG or practice).']) },
    code: { title: 'SQL II: JOINs, subqueries, DML, constraints, transactions',
      description: p('<code>INNER</code>/<code>LEFT JOIN</code>, subqueries, <code>INSERT</code>/<code>UPDATE</code>/<code>DELETE</code>, <code>CREATE TABLE</code> with <code>PRIMARY KEY</code>, <code>FOREIGN KEY</code>, <code>NOT NULL</code>, <code>UNIQUE</code>; transactions.'),
      task: ul(['10 queries with JOINs and subqueries.', '3 "find the data bug" queries (orphan rows, duplicates, impossible values) and a bug report for one of them.']) + p('Rules: no AI while solving. Submit the pull request link.') },
    qa: { focus: '<b>Checkpoint 2:</b> timed ISTQB sample exam on chapters 1–4 (70%+); 5 SQL queries unaided in 20 minutes; JUnit tests for a new class from an EP/BVA table.' } },

  { week: 11,
    theory: { title: 'client-server, HTTP, browser and DOM, locators',
      description: p('How a browser talks to a server: HTTP request/response, methods, status codes; HTML and the DOM; CSS selectors and XPath; DevTools.'),
      task: ul(['MDN "An overview of HTTP"; 10 questions from Alex.', 'On paper: CSS and XPath locators for 10 elements of saucedemo.com (login and inventory pages); check them in DevTools.']) },
    code: { title: 'Selenium 4 setup, first UI tests',
      description: p('Maven + JUnit 5 + Selenium 4 (Selenium Manager, no driver downloads); <code>WebDriver</code>, <code>By</code>, <code>findElement</code>; first login test on saucedemo.com.'),
      task: ul(['Repository <code>selenium-practice</code>: 4 login tests from an EP table (valid, locked_out_user, empty fields, wrong password).', 'README: what it is and how to run it.', 'Kata: one w3resource or HackerRank problem (number from Alex).']) + RULES },
    qa: { focus: 'review; "what happens when you type a URL" interview round; locators on paper.' } },

  { week: 12, light: true,
    theory: { title: 'exploratory testing and charters; what to automate (holiday, light)',
      description: p('ISTQB §4.4.2 exploratory testing, session-based testing and charters; what is worth automating; flaky tests.'),
      task: ul([`<b>${JIRA}:</b> write 2 test charters for MyONG (public 230 form; donor list of an NGO) as Jira comments or a page.`]) },
    code: { title: 'Selenium core: waits, dropdowns, actions, alerts (holiday, light)',
      description: p('<code>WebDriverWait</code> with <code>Duration</code> and <code>ExpectedConditions</code>; <code>Select</code>; <code>Actions</code>; alerts; why <code>Thread.sleep</code> is banned.'),
      task: ul(['3 cart tests on saucedemo (add, remove, badge count).', 'No <code>Thread.sleep</code> anywhere.']) + RULES },
    qa: null },

  { week: 13, light: true,
    theory: { title: 'chapter 4 drill on MyONG flows (holiday, light)',
      description: p('Decision tables and state transitions on real MyONG flows; chapter 4 retest.'),
      task: ul(['Chapter 4 retest (30 questions), 70%+, screenshot.']) },
    code: { title: 'live exploratory session on MyONG (holiday, light)',
      description: p('A time-boxed exploratory session on MyONG dev with your charter; notes; bugs filed in Jira.'),
      task: ul([`<b>${JIRA}:</b> finish the session report (charter, time, notes, bugs found) and file the bugs.`, '10-query SQL drill (sheet from Alex) in <code>sql/</code>.']) + p('Rules: no AI while solving. Submit the Jira links and the pull request link.') },
    qa: null },

  { week: 14,
    theory: { title: 'test automation framework anatomy, traceability, test data',
      description: p('ISTQB §1.4.3–1.4.4 testware and traceability; layers of a test framework (tests, page objects, utilities, configuration, test data); the test pyramid.'),
      task: ul(['README for <code>myong-test-automation</code>: scope, how to run, and a traceability table (Jira test case key → automated test).']) },
    code: { title: 'myong-test-automation: Page Object Model',
      description: p('New public repository <code>myong-test-automation</code> (Maven, JUnit 5, Selenium 4): page classes, a <code>BaseTest</code> with setup/teardown, configuration from environment variables (no URLs or secrets in code), test data out of the test body.'),
      task: ul(['Automate 5 of your Jira test cases for the public 230 form behind page objects; each test name or <code>@DisplayName</code> carries the Jira key.', 'Kata: one problem (number from Alex).']) + RULES },
    qa: { focus: 'review; Page Object Model interview round in English.' } },

  { week: 15,
    theory: { title: 'BDD: three amigos, Gherkin, ATDD vs BDD vs TDD',
      description: p('BDD (cucumber.io/docs/bdd): discovery, formulation, automation; three amigos; Gherkin rules; Scenario Outline. ISTQB §2.1.3 and §4.5 recap.'),
      task: ul(['Read cucumber.io/docs/bdd and the javatpoint Cucumber tutorial.', `<b>${JIRA}:</b> write Gherkin acceptance criteria for 2 MyONG stories (as a comment on each story).`]) },
    code: { title: 'Cucumber 7 in the framework',
      description: p('Cucumber 7 with the JUnit Platform engine: feature files, step definitions that reuse page objects, hooks, Scenario Outline, tags with Jira keys.'),
      task: ul(['2 feature files (one with Scenario Outline from your EP table).', 'README "How to run"; at least 10 green tests with <code>mvn test</code>.']) + RULES },
    qa: { focus: '<b>Checkpoint 3:</b> repository review (10+ green tests, POM, Cucumber, README) and a 3-minute English walkthrough of the framework.' } },

  { week: 16,
    theory: { title: 'REST and HTTP in depth, manual API testing',
      description: p('HTTP methods and idempotency, status code classes, headers, JSON, authentication tokens; manual API testing in Postman on MyONG dev; API tests as component integration testing.'),
      task: ul(['Postman collection with 8 requests to the MyONG dev API (positive and negative), exported into the repo.', 'English: record a 2-minute "tell me about yourself".']) },
    code: { title: 'REST Assured',
      description: p('REST Assured in <code>myong-test-automation</code>: given/when/then, status and body assertions, JSON path, request/response objects.'),
      task: ul(['5 API tests including negative ones (404, 400, 401).', 'Kata: one problem (number from Alex).']) + RULES },
    qa: { focus: '<b>Interview block 1:</b> ISTQB chapters 1–2 in English, one question at a time.' } },

  { week: 17,
    theory: { title: 'OOP revision through design patterns, SOLID',
      description: p('Singleton, Factory, Builder, Page Object; SOLID in one sentence each; how they appear in a test framework.'),
      task: ul(['Answer the Java/OOP interview question bank in writing (English).']) },
    code: { title: 'framework refactoring: DriverFactory, test data Builder, config',
      description: p('Refactor <code>myong-test-automation</code>: a <code>DriverFactory</code>, a test data <code>Builder</code>, one configuration class.'),
      task: ul(['Patterns in the repository, all tests green.', '10-query SQL drill.', 'Kata: one problem (number from Alex).']) + RULES },
    qa: { focus: '<b>Interview block 2:</b> Java and OOP in English.' } },

  { week: 18,
    theory: { title: 'timed ISTQB sample exam #2, Scrum and SDLC recap',
      description: p('Full timed ISTQB CTFL sample exam, then error analysis; Scrum and SDLC recap.'),
      task: ul(['Error analysis: for every wrong answer, the right answer and why (English).', 'CV in English and LinkedIn profile (draft for Alex).']) },
    code: { title: 'mock qualifying test #1',
      description: p('60 minutes: ISTQB chapters 1–4, Java problems on paper, SQL queries, logic. Review in the same session.'),
      task: ul(['Redo every mistake by hand and push the solutions.', 'Final README of both repositories.']) + p('Rules: no AI while solving. Submit the pull request link.') },
    qa: { focus: '<b>Interview block 3:</b> test design; final CV review; <b>apply</b> to Endava and Grid Dynamics.',
      task: { title: 'Week 18: Apply to Endava and Grid Dynamics', type: 'mandatory', xp: 20,
        description: p('Submit both applications with the final CV, GitHub and LinkedIn links. Attach screenshots of the confirmations.') } } },

  { week: 19,
    theory: { title: 'mock qualifying test #2',
      description: p('A second mock test with a new problem set, under time. Review in the same session.'),
      task: ul(['Redo every mistake by hand and push the solutions.']) },
    code: { title: 'mock interview in English (HR + technical)',
      description: p('Full mock interview in English: HR part, testing theory, Java, the framework walkthrough. <b>Checkpoint 4:</b> "would I pass this candidate to the next round".'),
      task: ul(['Write down every question you could not answer well and your improved answer.']), optional: true },
    qa: null },
];

const PHASES = {
  3: { name: 'Phase 1 — Java core and OOP (weeks 1–6, Oct 1 – Nov 15)',
    description: 'Goal: write correct Java by hand for HackerRank "easy" problems and explain the four OOP pillars with your own code; ISTQB chapters 1–3 on Mondays. From week 2: Monday theory, Wednesday live coding, Saturday Q&A. First test cases in MyONG Jira from week 3.' },
  4: { name: 'Phase 2 — Test design, JUnit, SQL, Scrum (weeks 7–10, Nov 16 – Dec 13)',
    description: 'Goal: pass an ISTQB CTFL 4.0 sample exam on chapters 1–4 at 70%+, design test cases with named techniques, unit-test your own classes with JUnit 5, join tables in SQL, and run your first test cycle with real bug reports in MyONG Jira. This is the phase Endava\'s qualifying test weighs most.' },
  5: { name: 'Phase 3 — Selenium, exploratory testing, framework, Cucumber (weeks 11–15, Dec 14 – Jan 17)',
    description: 'Goal: Selenium basics on saucedemo, an exploratory session with bugs on MyONG, then the public repository myong-test-automation with 10+ green UI tests behind page objects and Cucumber features, runnable with mvn test. Weeks 12–13 fall in the holidays and are light (no Saturday session).' },
  6: { name: 'Phase 4 — API testing, patterns, mock tests, application (weeks 16–19, Jan 18 – Feb 10)',
    description: 'Goal: API tests with REST Assured, framework patterns, interview blocks in English, two mock qualifying tests, and both applications submitted on Feb 6.' },
};
const pathOfWeek = (w) => (w <= 6 ? 3 : w <= 10 ? 4 : w <= 15 ? 5 : 6);

// ---------------------------------------------------------------------------------------------
async function api(method, pathname, body) {
  const res = await fetch(API + pathname, {
    method, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${text}`);
  return json;
}
const plan = []; let writes = 0;
async function write(what, method, pathname, body) {
  plan.push(`${APPLY ? 'DO ' : 'DRY'} ${method} ${pathname}  ${what}`); writes++;
  if (!APPLY) return { id: -writes };
  return api(method, pathname, body);
}
const lessonPos = (order) => ({ x: LAYOUT.firstX + LAYOUT.lessonSpacingX * (order - 1), y: LAYOUT.centerY });
const taskPos = (order, pos) => ({ x: pos.x + LAYOUT.firstTaskOffset, y: pos.y + LAYOUT.firstTaskOffset * (order % 2 !== 0 ? -1 : 1) });

// The nodes a week should have, in road order.
function nodesOf(w) {
  const mon = monday(w.week), wed = day(mon, 2), sat = day(mon, 5);
  const nodes = [
    { kind: 'theory', title: `Week ${w.week} · Mon ${label(mon).replace(/^\w+ /, '')} — Theory: ${w.theory.title}`, description: w.theory.description,
      task: { title: `Week ${w.week} theory homework`, type: 'mandatory', xp: 10, deadline: deadline(day(mon, 6)), description: w.theory.task } },
    { kind: 'code', title: `Week ${w.week} · Wed ${label(wed).replace(/^\w+ /, '')} — Live coding: ${w.code.title}`, description: w.code.description,
      task: { title: w.code.optional ? `Week ${w.week}: interview notes` : `Week ${w.week} homework (push to GitHub)`, type: w.code.optional ? 'optional' : 'mandatory',
        xp: w.code.optional ? 5 : 20, deadline: deadline(day(wed, 6)), description: w.code.task } },
  ];
  if (w.qa) {
    const t = w.qa.task || { ...QA_TASK(w.week), type: 'optional', xp: 5 };
    nodes.push({ kind: 'qa', title: `Week ${w.week} · Sat ${label(sat).replace(/^\w+ /, '')} — Q&A and mock interview`,
      description: p(`Saturday session (60 min): ${w.qa.focus}`),
      task: { ...t, deadline: deadline(sat) } });
  }
  return nodes;
}

const kindOf = (title) => (/Q&A/.test(title) ? 'qa' : /Testing theory|Theory/.test(title) ? 'theory' : 'code');

async function main() {
  for (const pathId of [3, 4, 5, 6]) {
    const ph = PHASES[pathId];
    const paths = await api('GET', '/paths');
    const cur = paths.find((x) => Number(x.id) === pathId);
    await write(`phase "${ph.name}"`, 'PUT', `/paths/${pathId}`, {
      name: ph.name, description: ph.description, stars_required: cur.requiredScore, course_id: cur.course_id, requires_previous: cur.requires_previous,
    });

    const details = await api('GET', `/paths/${pathId}/details`);
    const byWeek = new Map();
    for (const l of details) {
      const m = /^Week (\d+)\b/.exec(l.title); if (!m) throw new Error(`unexpected lesson title "${l.title}"`);
      const wk = Number(m[1]); if (!byWeek.has(wk)) byWeek.set(wk, {}); byWeek.get(wk)[kindOf(l.title)] = l;
    }

    let order = 0; let parentId = null;
    // Week 1 stays as it is; only its place on the road is counted.
    if (pathId === 3) {
      for (const l of [...details].filter((l) => /^Week 1\b/.test(l.title)).sort((a, b) => a.order_index - b.order_index)) { order++; parentId = l.id; }
    }

    for (const w of WEEKS.filter((x) => pathOfWeek(x.week) === pathId)) {
      const existing = byWeek.get(w.week) || {};
      for (const node of nodesOf(w)) {
        order++;
        const pos = lessonPos(order);
        const lesson = existing[node.kind];
        let lessonId;
        if (lesson) {
          await write(`lesson ${lesson.id} → "${node.title}" (order ${order})`, 'PUT', `/lessons/${lesson.id}`,
            { title: node.title, description: node.description, order, ...pos, parentId });
          lessonId = lesson.id;
        } else {
          const created = await write(`create "${node.title}" (order ${order})`, 'POST', '/lessons',
            { pathId, title: node.title, description: node.description, order, ...pos, parentId });
          lessonId = created.id;
        }
        const t = node.task; const tp = taskPos(order, pos);
        const oldTasks = lesson ? [...lesson.tasks].sort((a, b) => a.order_index - b.order_index) : [];
        if (oldTasks.length > 1) throw new Error(`lesson ${lesson.id} has ${oldTasks.length} tasks; expected at most one`);
        if (oldTasks[0]) {
          await write(`  task ${oldTasks[0].id} → "${t.title}" ${t.type} due ${t.deadline.slice(0, 10)}`, 'PUT', `/tasks/${oldTasks[0].id}`,
            { title: t.title, type: t.type, xp: t.xp, deadline: t.deadline, description: t.description, order: 1, ...tp });
        } else {
          await write(`  + task "${t.title}" ${t.type} due ${t.deadline.slice(0, 10)}`, 'POST', '/tasks',
            { lessonId, title: t.title, type: t.type, xp: t.xp, deadline: t.deadline, description: t.description, order: 1, ...tp });
        }
        parentId = lessonId;
      }
      for (const kind of Object.keys(existing)) {
        if (!nodesOf(w).some((n) => n.kind === kind)) throw new Error(`week ${w.week} has an extra "${kind}" lesson ${existing[kind].id}; resolve by hand`);
      }
    }
  }
  console.log(plan.join('\n'));
  console.log(`\n${APPLY ? 'Applied' : 'Dry run:'} ${writes} writes${APPLY ? '' : ' (re-run with --apply to execute)'}.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
