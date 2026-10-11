# Lesson script template

Scripts are the teacher's (Alex's) private plan, stored per lesson (`GET/PUT /lessons/:id/script`,
Markdown, admin only). Written **in Russian**, addressing Alex as «ты» and the student as «он».
They are 1:1 lessons, so a script is a minute-by-minute plan with the exact questions to ask.
Before writing a new one, read one or two neighbouring scripts (`lp.mjs script-get`) and copy their
tone and depth; existing scripts are 17–45k characters.

## Course rhythm (check `lp.mjs tree 1` for the current state)

| Day | Lesson type | Length | Title pattern |
|---|---|---|---|
| Mon | Theory (ISTQB, SDLC, HTTP…) | 60 min | `Week N · Mon DD Mon — Theory: <topic>` |
| Wed | Live coding (Java, JUnit, SQL, Selenium…) | 90 min | `Week N · Wed DD Mon — Live coding: <topic>` |
| Sat | Q&A and mock interview | 60 min | `Week N · Sat DD Mon — Q&A and mock interview` |

Script numbering is `Урок N.1 / N.2 / N.3` for Mon / Wed / Sat of week N.

## Skeleton

```markdown
# Сценарий урока N.K (Пн DD окт): <Тема> — ISTQB §x.y (60 минут)

**Привязка:** <работодатель/требование вакансии, напр. Endava — ISTQB CTFL 4.0 гл. 1 (must)>, ISTQB **§…**. <Grid Dynamics — …>.

**Цель урока:** к концу он <наблюдаемый результат: объясняет по-английски…, открыт PR…, таблица в README…>. Ты говоришь ≤ 40%.

---

## Шпаргалка для Алекса

### Термины ISTQB 4.0 (§…)
| Термин (EN) | Определение ISTQB одной фразой | Где расходится с практикой — это и ловит тест <работодателя> |
|---|---|---|

### Вопросы этого урока: правильный ответ / частая ошибка / наводящий вопрос
| # | Вопрос | Правильный ответ | Частый неверный и почему неверен | Наводящий вопрос |
|---|---|---|---|---|

### Java/инструменты — «изменилось с 2021»
- <что поменялось в JDK 21 / Selenium 4 / JUnit 5 и т.п., если релевантно>

### Пробы интервьюера после «учебного» ответа
| Проба | Как звучит хороший ответ |
|---|---|

---

## До урока

**Отправь ему в <день> вечером:**
> <короткое сообщение студенту: что подготовить>

**Чек-лист для тебя:**
- <что открыть, какие файлы/репозитории проверить заранее>

**Что ты НЕ делаешь:** <темы, которые будут позже — не забегать вперёд>

---

## 0–7 мин. <Название блока>

**Задача блока:** <что он делает и зачем>.

**Ты:** «<точная реплика>»

| Вопрос → | Ожидаемый ответ → | Если не знает, скажи… |
|---|---|---|

**Действие (его рука, бумага/клавиатура):** <что он делает сам>

**QA-мостик:** «<как это связано с работой тестировщика / собеседованием>»

**Контрольная точка 7-й минуты:** <проверяемый результат>.

## … (ещё 4–6 блоков; во второй половине клавиатура у него) …

## NN–NN мин. Из практики
<короткая реальная история из работы QA, 2–3 минуты>

## NN–NN мин. Самостоятельная проверка (я не трогаю клавиатуру и не подсказываю)

## NN–60 мин. Домашка и следующий урок
**Действие:** он открывает learning.bsf.md → Week N → «<название задачи>» и читает вслух.
| Задача | Что ты уточняешь вслух |
|---|---|

**Закрыть урок вопросом:** «<вопрос>»

---

## Карта QA-тем урока
| Термин | Где звучит сегодня | На каком примере | Подробно в roadmap |
|---|---|---|---|

---

## Если пошло не по плану
| Ситуация | Что делаешь |
|---|---|
| Отстаёшь на 10+ минут | <что резать, по приоритету; что не режется никогда> |
| Он быстрее плана | <доп. задание> |

## Приложение: <квиз / раздаточный материал, если есть>
```

## Rules of thumb

- Timings add up exactly to the lesson length; every block ends with a **checkable** checkpoint.
- Questions come with the expected answer, the typical wrong answer, and a hint — the teacher must
  never have to improvise the correction.
- The homework section must match the lesson's homework task text on the platform word for word in
  substance; if you change one, change the other.
- Facts in the cheat sheet follow the same accuracy rules as student content (content-standards.md).
