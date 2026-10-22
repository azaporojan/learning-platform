// Typing ")" or "]" right before the same character steps over it when the line already holds
// enough closers: the bracket came from a completion, a live template or an earlier edit, which the
// bracket closer does not track. With the line unbalanced the character is inserted as usual.
// Pure, so it runs in node tests; CodeEditor binds it to the keys.
export const shouldOvertype = (line: string, col: number, close: ')' | ']'): boolean => {
  if (line[col] !== close) return false;
  const open = close === ')' ? '(' : '[';
  let depth = 0;
  for (const ch of line.slice(0, col)) { if (ch === open) depth++; else if (ch === close) depth--; }
  let closers = 0;
  for (const ch of line.slice(col)) { if (ch === close) closers++; else if (ch === open) closers--; }
  return depth > 0 && closers >= depth;
};
