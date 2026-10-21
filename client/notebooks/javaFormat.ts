// "Reformat code" (Ctrl+Alt+L) for notebook cells: a small Java formatter in the spirit of
// IntelliJ's defaults, not a full one. It fixes the spacing within a line and re-indents every line
// by 4 spaces per block, with case bodies one level in and wrapped expressions 8 in. Strings, text
// blocks, chars and comments are never changed inside. Line breaks are kept as they are, apart from
// trailing spaces and runs of blank lines.

type Kind = 'ws' | 'nl' | 'lineComment' | 'blockComment' | 'string' | 'textBlock' | 'char' | 'number' | 'word' | 'op';
interface Token { kind: Kind; text: string; binary?: boolean; init?: boolean }

const OPS = ['>>>=', '<<=', '>>=', '>>>', '->', '::', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>'];
const KEYWORDS = new Set(['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while', 'var', 'record', 'yield', 'sealed', 'permits', 'non-sealed', 'true', 'false', 'null']);
// Keywords that end an operand, so a following + or - is binary ("this - 1", "null + x")
const VALUE_KEYWORDS = new Set(['this', 'super', 'null', 'true', 'false', 'class']);
const PAREN_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'try']);
const ALWAYS_SPACED = new Set(['=', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '->']);
const ARITH = new Set(['+', '-', '*', '/', '%']);
const AFTER_BRACE_WORDS = new Set(['else', 'catch', 'finally', 'while']);
const ANGLES = new Set(['<', '>', '<<', '>>', '>>>']);
// "<" or ">" compares (or shifts) when the left side is a value, not a type name: "i < 10",
// "a.size() > 0", but "List<String>" and "Map<String, List<Integer>>" stay generics
const comparesAfter = (t?: Token) => Boolean(t && endsOperand(t) && !(t.kind === 'word' && /^[A-Z]/.test(t.text)));

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;
    if (c === '\n') { out.push({ kind: 'nl', text: '\n' }); i += 1; continue; }
    if ((m = rest.match(/^[ \t\r\f]+/))) { out.push({ kind: 'ws', text: m[0] }); i += m[0].length; continue; }
    if (rest.startsWith('//')) { const end = src.indexOf('\n', i); const j = end === -1 ? n : end; out.push({ kind: 'lineComment', text: src.slice(i, j) }); i = j; continue; }
    if (rest.startsWith('/*')) { const end = src.indexOf('*/', i + 2); const j = end === -1 ? n : end + 2; out.push({ kind: 'blockComment', text: src.slice(i, j) }); i = j; continue; }
    if (rest.startsWith('"""')) {
      let j = i + 3;
      while (j < n && !(src.startsWith('"""', j) && src[j - 1] !== '\\')) j += 1;
      j = Math.min(n, j + 3);
      out.push({ kind: 'textBlock', text: src.slice(i, j) }); i = j; continue;
    }
    if (c === '"' || c === '\'') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(n, src[j] === c ? j + 1 : j);
      out.push({ kind: c === '"' ? 'string' : 'char', text: src.slice(i, j) }); i = j; continue;
    }
    if ((m = rest.match(/^(0[xX][\da-fA-F_]+[lL]?|0[bB][01_]+[lL]?|(\d[\d_]*\.?[\d_]*|\.\d[\d_]*)([eE][+-]?\d+)?[lLfFdD]?)/)) && /[\d.]/.test(c) && !(c === '.' && !/\d/.test(src[i + 1] || ''))) {
      out.push({ kind: 'number', text: m[0] }); i += m[0].length; continue;
    }
    if ((m = rest.match(/^[A-Za-z_$][\w$]*/))) { out.push({ kind: 'word', text: m[0] }); i += m[0].length; continue; }
    const op = OPS.find((o) => rest.startsWith(o)) || c;
    out.push({ kind: 'op', text: op }); i += op.length;
  }
  return out;
}

const isWord = (t?: Token) => Boolean(t && t.kind === 'word');
const isKeyword = (t?: Token) => Boolean(t && t.kind === 'word' && KEYWORDS.has(t.text));
// Ends an operand: what can stand left of a binary operator
const endsOperand = (t?: Token) => Boolean(t && (
  (t.kind === 'word' && (!KEYWORDS.has(t.text) || VALUE_KEYWORDS.has(t.text)))
  || t.kind === 'number' || t.kind === 'string' || t.kind === 'char' || t.kind === 'textBlock'
  || (t.kind === 'op' && [')', ']', '++', '--'].includes(t.text))));

/** The space between two tokens on the same line; `orig` is what was there. */
function gap(prev: Token, cur: Token, orig: string): string {
  const keep = orig ? ' ' : '';
  const p = prev.text;
  const c = cur.text;
  if (cur.kind === 'lineComment' || cur.kind === 'blockComment' || prev.kind === 'blockComment') return orig ? ' ' : (cur.kind === 'lineComment' ? ' ' : keep);
  if (prev.kind === 'op' && ['(', '[', '.', '::', '@', '!', '~'].includes(p)) return '';
  if (cur.kind === 'op' && [',', ';', ')', ']', '.', '::'].includes(c)) return '';
  if (cur.kind === 'op' && (c === '++' || c === '--') && endsOperand(prev)) return '';
  if (prev.kind === 'op' && (p === '++' || p === '--') && !prev.binary) return '';
  if (prev.kind === 'op' && (p === ',' || p === ';')) return ' ';
  if (cur.kind === 'op' && c === '(') {
    // After an operator first: "x = (int) y", "a * (b + c)", but "-(x)"
    if (prev.kind === 'op' && ALWAYS_SPACED.has(p)) return ' ';
    if (prev.kind === 'op' && ARITH.has(p)) return prev.binary ? ' ' : '';
    if (isWord(prev) && PAREN_KEYWORDS.has(p)) return ' ';
    if (isWord(prev) && !KEYWORDS.has(p)) return '';
    if (isWord(prev) && ['this', 'super', 'new'].includes(p)) return '';
    return keep;
  }
  // Array initializers stay tight: new int[]{1, 2, 3}, int[] a = {1, 2}
  if (cur.kind === 'op' && c === '{') return prev.kind === 'op' && ['{', ']', '('].includes(p) ? '' : ' ';
  if (prev.kind === 'op' && p === '{') return prev.init || (cur.kind === 'op' && c === '}') ? '' : ' ';
  if (cur.kind === 'op' && c === '}') return cur.init ? '' : ' ';
  if (cur.kind === 'op' && ANGLES.has(c)) return cur.binary ? ' ' : (prev.kind === 'op' && ANGLES.has(p) ? '' : (isWord(prev) ? '' : keep));
  // After a generic: "List<String> names", "new ArrayList<>()", "Map<K, V>>"
  if (prev.kind === 'op' && ANGLES.has(p)) return prev.binary ? ' ' : (p.startsWith('>') && (isWord(cur) || cur.kind === 'op' && c === '?') ? ' ' : '');
  if (prev.kind === 'op' && p === '}' && isWord(cur) && AFTER_BRACE_WORDS.has(c)) return ' ';
  if ((cur.kind === 'op' && ALWAYS_SPACED.has(c)) || (prev.kind === 'op' && ALWAYS_SPACED.has(p))) return ' ';
  if (cur.kind === 'op' && ARITH.has(c)) return cur.binary ? ' ' : keep;
  if (prev.kind === 'op' && ARITH.has(p)) return prev.binary ? ' ' : '';
  if ((isWord(prev) || prev.kind === 'number') && (isWord(cur) || cur.kind === 'number')) return ' ';
  if (prev.kind === 'op' && p === ')' && (isWord(cur) || cur.kind === 'number' || cur.kind === 'string' || cur.kind === 'char')) return ' '; // "(int) x", "if (ok) x++"
  return keep;
}

/** Same-line spacing for the whole cell; line breaks stay where they are. */
export function formatSpacing(src: string): string {
  const tokens = tokenize(src);
  // Decide which + - * / % ++ -- are binary (or postfix) before spacing them
  // and which braces belong to array initializers (after "]" or "=", and nested in one)
  let prevSig: Token | undefined;
  let prevSig2: Token | undefined;
  const braces: boolean[] = [];
  for (const t of tokens) {
    if (t.kind === 'ws' || t.kind === 'nl' || t.kind === 'lineComment' || t.kind === 'blockComment') continue;
    if (t.kind === 'op' && (ARITH.has(t.text) || t.text === '++' || t.text === '--')) t.binary = endsOperand(prevSig);
    // "int[]>" closes a generic (an empty [] is an array type); "a[i] > x" compares
    if (t.kind === 'op' && ANGLES.has(t.text)) t.binary = comparesAfter(prevSig) && !(prevSig && prevSig.text === ']' && prevSig2 && prevSig2.text === '[');
    if (t.kind === 'op' && t.text === '{') {
      const p = prevSig && prevSig.kind === 'op' ? prevSig.text : '';
      t.init = p === ']' || p === '=' || ((p === '{' || p === ',') && braces.length > 0 && braces[braces.length - 1]);
      braces.push(Boolean(t.init));
    }
    if (t.kind === 'op' && t.text === '}') t.init = Boolean(braces.pop());
    prevSig2 = prevSig;
    prevSig = t;
  }
  let out = '';
  let prev: Token | undefined;
  let pending = '';
  let lineStart = true;
  for (const t of tokens) {
    if (t.kind === 'ws') { pending += t.text; continue; }
    if (t.kind === 'nl') { out += '\n'; pending = ''; lineStart = true; prev = undefined; continue; }
    if (lineStart) { out += pending; lineStart = false; } // leading indentation: replaced by reindent
    else if (prev) out += gap(prev, t, pending);
    out += t.text;
    pending = '';
    // A text block or block comment spanning lines leaves "prev" at its end; spacing after it is kept
    prev = t;
  }
  return out;
}

/** Re-indents every line: 4 per open brace, case bodies one level in, 8 for wrapped expressions. */
export function reindent(src: string): string {
  const lines = src.split('\n');
  const tokens = tokenize(src);
  // Which lines are inside a text block or block comment (left exactly as they are, apart from the first)
  const verbatim = new Set<number>();
  let line = 0;
  for (const t of tokens) {
    const breaks = (t.text.match(/\n/g) || []).length;
    if ((t.kind === 'textBlock' || t.kind === 'blockComment') && breaks) for (let k = 1; k <= breaks; k += 1) verbatim.add(line + k);
    line += breaks;
  }
  const out: string[] = [];
  let braces = 0; // open {
  let parens = 0; // open ( and [
  const switchDepths: number[] = []; // brace depth of each open switch body
  let inCase = false;
  let pendingSwitch = false;
  let continuation = false; // previous code line ended mid-expression
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const text = raw.trim();
    if (verbatim.has(i)) { out.push(raw.replace(/\s+$/, '')); continue; }
    if (!text) { out.push(''); continue; }
    const code = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').replace(/\/\*.*$/, '');
    const leadingClose = (code.match(/^[}\])]+/) || [''])[0];
    let depth = braces - (leadingClose.match(/}/g) || []).length;
    let extra = Math.max(0, parens - (leadingClose.match(/[)\]]/g) || []).length) * 2;
    const isCaseLabel = /^(case\b|default\s*(:|->))/.test(code);
    const inSwitchBody = switchDepths.length > 0 && switchDepths[switchDepths.length - 1] === braces;
    if (inSwitchBody && inCase && !isCaseLabel && !leadingClose.includes('}')) depth += 1;
    if (!extra && (continuation || /^\./.test(code)) && !leadingClose && !isCaseLabel) extra = 2;
    out.push(' '.repeat(4 * Math.max(0, depth + extra)) + text);
    // Update the state with this line's brackets
    if (/\bswitch\b/.test(code)) pendingSwitch = true;
    for (const ch of code) {
      if (ch === '{') {
        braces += 1;
        if (pendingSwitch) { switchDepths.push(braces); pendingSwitch = false; inCase = false; }
      } else if (ch === '}') {
        if (switchDepths.length && switchDepths[switchDepths.length - 1] === braces) { switchDepths.pop(); inCase = false; }
        braces = Math.max(0, braces - 1);
      } else if (ch === '(' || ch === '[') parens += 1;
      else if (ch === ')' || ch === ']') parens = Math.max(0, parens - 1);
    }
    if (isCaseLabel && /:\s*$/.test(code)) inCase = true;
    if (isCaseLabel && /->/.test(code)) inCase = false;
    const end = code.replace(/\s+$/, '');
    continuation = Boolean(end) && parens === 0 && /([=+\-*/%&|?:^]|->|&&|\|\|)$/.test(end) && !/^(case\b|default\b)/.test(code);
  }
  return out.join('\n');
}

/**
 * Spacing, indentation and trailing spaces, with exactly the same lines as the input, so a
 * selection can take its lines from the formatted whole (and keep the right block depth).
 */
export function formatJavaLines(src: string): string[] {
  return reindent(formatSpacing(src)).split('\n').map((l) => l.replace(/[ \t]+$/, ''));
}

/** The whole "Reformat code": spacing, indentation, trailing spaces, at most one blank line in a row. */
export function formatJava(src: string): string {
  const spaced = formatSpacing(src);
  const indented = reindent(spaced);
  return indented
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}
