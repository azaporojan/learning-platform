// Which outline heading is "current" while the notebook scrolls: the last heading whose top has
// passed the reading line (just under the sticky toolbar), or the first one before any has.
// At the very bottom of the page the last heading wins, even if it never reaches the line.
// tops: each heading's top in viewport pixels, null when it is not on the page. null = none.
export function activeHeadingIndex(tops: (number | null)[], line: number, atBottom: boolean): number | null {
  let first: number | null = null;
  let passed: number | null = null;
  let last: number | null = null;
  tops.forEach((top, i) => {
    if (top === null) return;
    if (first === null) first = i;
    if (top <= line) passed = i;
    last = i;
  });
  return atBottom ? last : passed ?? first;
}
