// "Test BubbleSort only": the class whose hidden tests a try runs, from the open file
// (shop/BubbleSort.java → BubbleSort). Non-Java names give null; the server answers 400 for a
// class without hidden tests of its own.
export const classOfFile = (path: string | null | undefined): string | null => {
  const name = (path || '').split('/').pop()?.replace(/\.java$/, '') || '';
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return null;
  return name;
};

// Failing tests grouped by test class: "BubbleSortTest: sorts…" / "BubbleSortTest.sorts" → "BubbleSortTest"
export const groupFailures = <T extends { name: string }>(failed: T[]): { group: string; items: T[] }[] => {
  const groups = new Map<string, T[]>();
  for (const f of failed) {
    const m = /^([A-Za-z_$][A-Za-z0-9_$]*)(?::\s|\.)/.exec(f.name);
    const key = m ? m[1] : '';
    groups.set(key, [...(groups.get(key) || []), f]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
};
