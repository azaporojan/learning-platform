#!/usr/bin/env python3
"""Check a quiz or flashcard JSON document before it is published.

    python3 check_study_set.py set.json [more.json ...]

Accepts the body of POST /api/study-sets ({kind, title, items, ...}) or of PUT ({items}) with
--kind quiz|flashcards. Errors are things the API would reject; warnings are quality problems
(the course's own rules) worth fixing before students see them. Exit code 1 on any error.
"""
import json
import re
import sys
from collections import Counter


def check(doc, kind):
    errors, warnings = [], []
    items = doc.get("items")
    if not isinstance(items, list) or not items:
        return ["items must be a non-empty list"], []
    if len(items) > 300:
        errors.append("more than 300 items")
    kind = doc.get("kind", kind)
    if kind not in ("quiz", "flashcards"):
        return ["kind must be 'quiz' or 'flashcards' (pass --kind for a PUT body)"], []
    if "title" in doc and not str(doc["title"]).strip():
        errors.append("title is empty")

    if kind == "quiz":
        positions = Counter()
        longest_correct = 0
        for n, it in enumerate(items, 1):
            q, opts, cor = it.get("question", ""), it.get("options"), it.get("correct")
            if not str(q).strip():
                errors.append(f"Q{n}: empty question")
            if len(str(q)) > 4000:
                errors.append(f"Q{n}: question longer than 4000 chars")
            if not isinstance(opts, list) or not 2 <= len(opts) <= 10:
                errors.append(f"Q{n}: needs 2-10 options")
                continue
            if any(not str(o).strip() for o in opts):
                errors.append(f"Q{n}: empty option")
            if len({str(o).strip().lower() for o in opts}) != len(opts):
                errors.append(f"Q{n}: duplicate options")
            idx = cor if isinstance(cor, list) else [cor]
            if not idx or any(not isinstance(i, int) or not 0 <= i < len(opts) for i in idx):
                errors.append(f"Q{n}: 'correct' must index into options")
                continue
            if len(set(idx)) != len(idx):
                errors.append(f"Q{n}: duplicate indexes in 'correct'")
            if len(idx) == 1:
                positions[idx[0]] += 1
            if not str(it.get("explanation", "")).strip():
                warnings.append(f"Q{n}: no explanation (students learn most from why an option is wrong)")
            if any(re.search(r"\b(all|none) of the above\b", str(o), re.I) for o in opts):
                warnings.append(f"Q{n}: 'all/none of the above' (ISTQB exams do not use it; reorder-safe options only)")
            longest = max(len(str(o)) for o in opts)
            if len(idx) == 1 and len(str(opts[idx[0]])) == longest:
                longest_correct += 1
            if len(idx) == 1 and len(str(opts[idx[0]])) == longest and longest > 1.6 * sorted(len(str(o)) for o in opts)[-2]:
                warnings.append(f"Q{n}: the correct option is by far the longest (a giveaway)")
        single = sum(positions.values())
        if single >= 8 and longest_correct > 0.35 * single:
            warnings.append(f"the correct option is the longest one in {longest_correct}/{single} questions; "
                            "students learn to pick the longest answer (aim for at most ~1/3)")
        if single >= 8:
            top_pos, top = positions.most_common(1)[0]
            if top > 0.4 * single:
                warnings.append(f"answer positions unbalanced: option {'abcdefghij'[top_pos]} is correct "
                                f"{top}/{single} times {dict(sorted(positions.items()))}; students can game it")
    else:
        for n, it in enumerate(items, 1):
            f, b = str(it.get("front", "")), str(it.get("back", ""))
            if not f.strip() or not b.strip():
                errors.append(f"card {n}: front and back are required")
            if len(f) > 4000 or len(b) > 4000:
                errors.append(f"card {n}: front/back longer than 4000 chars")
            if not (f.rstrip().endswith("?") or re.match(r"\s*(explain|describe|name|give|compare|list|what|why|how)\b", f, re.I)):
                warnings.append(f"card {n}: front is not phrased as a question ('What is …?', 'Explain …')")
            if "example" not in b.lower():
                warnings.append(f"card {n}: back has no example")
    return errors, warnings


def main():
    args = sys.argv[1:]
    kind = None
    if "--kind" in args:
        i = args.index("--kind")
        kind = args[i + 1]
        del args[i:i + 2]
    if not args:
        print(__doc__)
        sys.exit(2)
    bad = False
    for path in args:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        errors, warnings = check(doc, kind)
        print(f"== {path}: {len(doc.get('items', []))} items, {len(errors)} errors, {len(warnings)} warnings")
        for e in errors:
            print("  ERROR  ", e)
        for w in warnings:
            print("  warning", w)
        bad |= bool(errors)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
