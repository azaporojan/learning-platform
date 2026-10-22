// Static checks for a Java notebook cell, shown in the editor before the code is run: syntax slips
// (a missing ';', ')' or '}'), conditions that are always true or false, strings compared with
// '==', a few methods that do not exist on the types the cell itself declares. Pure: no editor
// imports, so it runs in node tests. The sandbox (javac) stays the final word; these are the
// mistakes it would reject anyway, or that compile and surprise.
import { javaLanguage } from '@codemirror/lang-java';
import type { SyntaxNode, Tree } from '@lezer/common';

export type Severity = 'error' | 'warning';

export interface JavaDiagnostic {
  from: number;
  to: number;
  severity: Severity;
  message: string;
}

// Methods of the JDK types a cell most often declares; a call to anything else is flagged
const STRING_METHODS = new Set(['length', 'charAt', 'isEmpty', 'isBlank', 'substring', 'indexOf', 'lastIndexOf', 'contains', 'startsWith',
  'endsWith', 'equals', 'equalsIgnoreCase', 'compareTo', 'compareToIgnoreCase', 'toUpperCase', 'toLowerCase', 'trim', 'strip',
  'stripLeading', 'stripTrailing', 'replace', 'replaceAll', 'replaceFirst', 'split', 'concat', 'toCharArray', 'chars', 'matches',
  'format', 'formatted', 'valueOf', 'join', 'repeat', 'lines', 'hashCode', 'toString', 'getBytes', 'codePointAt', 'intern',
  'getClass', 'describeConstable', 'codePoints', 'subSequence', 'indent', 'translateEscapes', 'stripIndent', 'regionMatches',
  'copyValueOf', 'contentEquals', 'transform', 'splitWithDelimiters']);
const LIST_METHODS = new Set(['size', 'get', 'set', 'add', 'addAll', 'remove', 'removeAll', 'removeIf', 'retainAll', 'clear', 'contains',
  'containsAll', 'indexOf', 'lastIndexOf', 'isEmpty', 'iterator', 'listIterator', 'forEach', 'stream', 'parallelStream', 'sort',
  'subList', 'toArray', 'equals', 'hashCode', 'toString', 'of', 'copyOf', 'reversed', 'getFirst', 'getLast', 'addFirst', 'addLast',
  'removeFirst', 'removeLast', 'replaceAll', 'spliterator', 'ensureCapacity', 'trimToSize', 'getClass', 'clone']);
const MAP_METHODS = new Set(['size', 'get', 'put', 'putAll', 'putIfAbsent', 'remove', 'clear', 'containsKey', 'containsValue', 'isEmpty',
  'keySet', 'values', 'entrySet', 'forEach', 'getOrDefault', 'merge', 'compute', 'computeIfAbsent', 'computeIfPresent', 'replace',
  'replaceAll', 'equals', 'hashCode', 'toString', 'of', 'copyOf', 'entry', 'ofEntries', 'getClass', 'clone', 'firstKey', 'lastKey',
  'firstEntry', 'lastEntry', 'headMap', 'tailMap', 'subMap', 'ceilingKey', 'floorKey', 'higherKey', 'lowerKey', 'pollFirstEntry',
  'pollLastEntry', 'descendingMap', 'navigableKeySet', 'descendingKeySet', 'comparator']);
const PRINT_STREAM_METHODS = new Set(['println', 'print', 'printf', 'format', 'flush', 'write', 'append', 'checkError', 'close', 'writeBytes', 'getClass', 'toString', 'equals', 'hashCode', 'charset']);

type Known = 'String' | 'array' | 'List' | 'Map';
const TYPE_NAMES: Record<string, Known> = { String: 'String', List: 'List', ArrayList: 'List', LinkedList: 'List', Map: 'Map', HashMap: 'Map', TreeMap: 'Map', LinkedHashMap: 'Map' };
const TYPO_TYPES: Record<string, string> = { string: 'String', Int: 'int', integer: 'Integer', bool: 'boolean', Bool: 'boolean', Boolean_: 'boolean', Char: 'char', Long: 'long', Double: 'double' };
const TYPO_SYSTEM: Record<string, string> = { Sytem: 'System', system: 'System', Sytsem: 'System', Systen: 'System', Sistem: 'System' };

// Characters that a missing-semicolon error cannot follow: the statement is still open
const OPENERS = /[;{}(,\[]$/;

interface Scope { get: (name: string) => Known | null; declare: (name: string, type: Known | null) => void }

function makeScope(): Scope {
  // A name declared with two different types in the cell is ambiguous and not checked
  const types = new Map<string, Known | null>();
  return {
    get: (n) => types.get(n) ?? null,
    declare: (n, t) => { types.set(n, types.has(n) && types.get(n) !== t ? null : t); },
  };
}

const text = (src: string, n: SyntaxNode | null) => (n ? src.slice(n.from, n.to) : '');

function knownType(src: string, typeNode: SyntaxNode | null, init: SyntaxNode | null): Known | null {
  if (!typeNode) return null;
  if (typeNode.name === 'ArrayType') return 'array';
  if (typeNode.name === 'TypeName') return TYPE_NAMES[text(src, typeNode)] ?? null;
  if (typeNode.name === 'GenericType') return TYPE_NAMES[text(src, typeNode.firstChild)] ?? null;
  if (typeNode.name === 'var' && init) {
    if (init.name === 'StringLiteral') return 'String';
    if (init.name === 'ArrayCreationExpression') return 'array';
    if (init.name === 'ObjectCreationExpression') {
      const t = init.getChild('GenericType') || init.getChild('TypeName');
      return t ? knownType(src, t, null) : null;
    }
  }
  return null;
}

function sameText(src: string, a: SyntaxNode | null, b: SyntaxNode | null): boolean {
  return Boolean(a && b && a.name === b.name && text(src, a) === text(src, b));
}

// ---------------------------------------------------------------------------
// Chunks: JShell lets a cell hold statements AND method declarations side by side, which Lezer's
// Java grammar (classes only at the top) rejects. Each top-level chunk is parsed on its own and,
// when that fails, once more as a class member; the parse without errors wins.
// ---------------------------------------------------------------------------
interface Chunk { from: number; to: number }

export function topLevelChunks(src: string): Chunk[] {
  const chunks: Chunk[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const n = src.length;
  const skipWs = (j: number) => { while (j < n && /\s/.test(src[j])) j++; return j; };
  const wordAt = (j: number) => (src.slice(j).match(/^[A-Za-z_$][\w$]*/) || [''])[0];
  const close = (end: number) => { if (src.slice(start, end).trim()) chunks.push({ from: start, to: end }); start = end; };
  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < n && src[i] !== '\n') i++; continue; }
    if (two === '/*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (src.startsWith('"""', i)) { const e = src.indexOf('"""', i + 3); i = e === -1 ? n : e + 3; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') { depth++; i++; continue; }
    if (c === ')' || c === ']') { depth = Math.max(0, depth - 1); i++; continue; }
    if (c === '}') {
      depth = Math.max(0, depth - 1);
      i++;
      if (depth === 0) {
        const next = wordAt(skipWs(i));
        const first = wordAt(skipWs(start));
        // "} else", "} catch", "do {} while", and a block that is part of an expression:
        // an array initializer "{1, 2};", "new X() {}.run()", a lambda body "x -> {}" as an argument
        const continues = ['else', 'catch', 'finally'].includes(next) || (next === 'while' && first === 'do') || /^[;,.)=]/.test(src.slice(skipWs(i), skipWs(i) + 1));
        if (!continues) close(i);
      }
      continue;
    }
    if (c === ';' && depth === 0) { i++; close(i); continue; }
    i++;
  }
  close(n);
  return chunks;
}

const errorCount = (tree: Tree) => { let k = 0; tree.iterate({ enter: (n) => { if (n.type.isError) k++; } }); return k; };

interface Parsed { tree: Tree; offset: number; source: string }

function parseChunk(src: string, chunk: Chunk, last: boolean): Parsed {
  const piece = src.slice(chunk.from, chunk.to);
  const plain = javaLanguage.parser.parse(piece);
  if (errorCount(plain) === 0) return { tree: plain, offset: chunk.from, source: piece };
  if (last && !/[;}]\s*$/.test(piece)) {
    // JShell takes the cell's last expression without ';' and shows its value
    const closed = javaLanguage.parser.parse(piece + ';');
    if (errorCount(closed) === 0) return { tree: closed, offset: chunk.from, source: piece + ';' };
  }
  const prefix = 'class _ {\n';
  const wrapped = javaLanguage.parser.parse(prefix + piece + '\n}');
  if (errorCount(wrapped) === 0) return { tree: wrapped, offset: chunk.from - prefix.length, source: prefix + piece + '\n}' };
  return { tree: plain, offset: chunk.from, source: piece };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
const MISSING_CLOSER: Record<string, string> = { ArgumentList: "')'", FormalParameters: "')'", ParenthesizedExpression: "')'", Block: "'}'", ClassBody: "'}'", ArrayInitializer: "'}'", TypeArguments: "'>'", ForSpec: "')'" };

export function lintJava(src: string): JavaDiagnostic[] {
  const out: JavaDiagnostic[] = [];
  const scope = makeScope();
  const chunks = topLevelChunks(src);
  const parsed = chunks.map((c, i) => parseChunk(src, c, i === chunks.length - 1 && !src.slice(c.to).trim()));
  // Declarations first, so a method declared below its first use still types its arguments
  for (const p of parsed) collectDeclarations(p, scope);
  chunks.forEach((chunk, i) => {
    const p = parsed[i];
    const last = i === chunks.length - 1 && !src.slice(chunk.to).trim();
    syntaxErrors(src, p, chunk, last, out);
    walk(p.tree.topNode, (n) => checkNode(src, p, n, scope, out));
  });
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  // One message per position: the parser's cascades repeat themselves
  return out.filter((d, i) => i === 0 || d.from !== out[i - 1].from || d.message !== out[i - 1].message);
}

function walk(node: SyntaxNode, visit: (n: SyntaxNode) => void) {
  visit(node);
  for (let c = node.firstChild; c; c = c.nextSibling) walk(c, visit);
}

function collectDeclarations(p: Parsed, scope: Scope) {
  const src = p.source;
  walk(p.tree.topNode, (n) => {
    if (n.name === 'LocalVariableDeclaration' || n.name === 'FieldDeclaration') {
      const typeNode = n.getChild('ArrayType') || n.getChild('TypeName') || n.getChild('GenericType') || n.getChild('var') || n.getChild('PrimitiveType');
      for (const d of n.getChildren('VariableDeclarator')) {
        const name = text(src, d.getChild('Definition'));
        const init = d.lastChild && d.lastChild.name !== 'Definition' ? d.lastChild : null;
        // "int[] a" declares the array on the type; "int a[]" on the declarator
        const arrayDeclarator = d.getChild('Dimension') !== null;
        if (name) scope.declare(name, arrayDeclarator ? 'array' : knownType(src, typeNode, init));
      }
    } else if (n.name === 'FormalParameter' || n.name === 'SpreadParameter') {
      const typeNode = n.getChild('ArrayType') || n.getChild('TypeName') || n.getChild('GenericType') || n.getChild('PrimitiveType');
      const name = text(src, n.getChild('Definition'));
      if (name) scope.declare(name, n.name === 'SpreadParameter' ? 'array' : knownType(src, typeNode, null));
    } else if (n.name === 'LambdaExpression') {
      // Untyped lambda parameters shadow anything: unknown from here on
      const params = n.getChild('LambdaParameters') || n.getChild('FormalParameters');
      const names = params ? params.getChildren('Definition').map((d) => text(src, d)) : (n.firstChild?.name === 'Definition' ? [text(src, n.firstChild)] : []);
      for (const name of names) if (name) scope.declare(name, null);
      if (params) for (const fp of params.getChildren('FormalParameter')) scope.declare(text(src, fp.getChild('Definition')), null);
    } else if (n.name === 'EnhancedForStatement' || n.name === 'CatchFormalParameter') {
      const name = text(src, n.getChild('Definition'));
      const typeNode = n.getChild('ArrayType') || n.getChild('TypeName') || n.getChild('GenericType') || n.getChild('PrimitiveType');
      if (name) scope.declare(name, knownType(src, typeNode, null));
    }
  });
}

function syntaxErrors(src: string, p: Parsed, chunk: Chunk, lastChunk: boolean, out: JavaDiagnostic[]) {
  p.tree.iterate({
    enter: (ref) => {
      if (!ref.type.isError) return;
      const node = ref.node;
      const from = Math.max(chunk.from, Math.min(chunk.to, ref.from + p.offset));
      const to = Math.max(chunk.from, Math.min(chunk.to, ref.to + p.offset));
      if (to > from) {
        out.push({ from, to, severity: 'error', message: `Unexpected '${src.slice(from, to).trim().split(/\s+/)[0]}'` });
        return;
      }
      const parent = node.parent;
      const before = src.slice(chunk.from, from).replace(/\s+$/, '');
      const atEnd = !src.slice(from, chunk.to).trim();
      const statementLike = parent && /Statement|Declaration$/.test(parent.name) && parent.name !== 'IfStatement' && parent.name !== 'ForStatement' && parent.name !== 'WhileStatement';
      if (statementLike && atEnd && !OPENERS.test(before)) {
        // JShell takes the cell's last statement without ';' (it is an expression to show)
        if (lastChunk) return;
        out.push({ ...tokenBefore(src, from), severity: 'error', message: "Missing ';' at the end of the statement" });
        return;
      }
      const closer = parent ? MISSING_CLOSER[parent.name] : undefined;
      if (closer && atEnd) {
        out.push({ ...tokenBefore(src, from), severity: 'error', message: `Missing ${closer}: this ${parent!.name === 'Block' || parent!.name === 'ClassBody' ? 'block' : 'expression'} is never closed` });
        return;
      }
      if (statementLike && !OPENERS.test(before) && from < chunk.to) {
        out.push({ ...tokenBefore(src, from), severity: 'error', message: "Missing ';' between two statements" });
        return;
      }
      out.push({ ...tokenBefore(src, from), severity: 'error', message: closer ? `Syntax error: missing ${closer}?` : 'Syntax error: the statement is incomplete' });
    },
  });
}

// The last non-space token before an offset, to underline something visible
function tokenBefore(src: string, pos: number): { from: number; to: number } {
  let to = pos;
  while (to > 0 && /\s/.test(src[to - 1])) to--;
  let from = to;
  while (from > 0 && /[\w$"'.)\]]/.test(src[from - 1])) from--;
  if (from === to) from = Math.max(0, to - 1);
  return { from, to: Math.max(to, from + 1) };
}

function checkNode(cell: string, p: Parsed, n: SyntaxNode, scope: Scope, out: JavaDiagnostic[]) {
  const src = p.source;
  const at = (node: SyntaxNode): { from: number; to: number } => ({ from: Math.max(0, node.from + p.offset), to: Math.max(0, node.to + p.offset) });
  const push = (node: SyntaxNode, severity: Severity, message: string) => out.push({ ...at(node), severity, message });

  if (n.name === 'IfStatement' || n.name === 'WhileStatement' || n.name === 'DoStatement') {
    const cond = n.getChild('ParenthesizedExpression');
    const inner = cond && cond.firstChild ? cond.firstChild.nextSibling : null;
    if (inner && inner.name === 'BooleanLiteral' && !(n.name !== 'IfStatement' && text(src, inner) === 'true')) {
      push(inner, 'warning', `Condition is always ${text(src, inner)}`);
    }
    if (inner && inner.name === 'AssignmentExpression' && text(src, inner.getChild('AssignOp')) === '=') {
      push(inner, 'warning', "Assignment '=' inside a condition: did you mean '=='?");
    }
    // if (x); — the semicolon ends the statement, the block below runs every time
    const semi = n.getChild(';');
    const block = n.getChild('Block');
    if (n.name !== 'DoStatement' && semi && !block && semi.prevSibling && semi.prevSibling.name === 'ParenthesizedExpression') {
      push(semi, 'warning', `';' right after the condition: this ${n.name === 'IfStatement' ? 'if' : 'loop'} does nothing`);
    }
  }
  if (n.name === 'ForStatement') {
    const semi = n.lastChild;
    if (semi && semi.name === ';' && semi.prevSibling && semi.prevSibling.name === 'ForSpec') push(semi, 'warning', "';' right after the loop header: the loop body is empty");
  }
  if (n.name === 'BinaryExpression') {
    const op = n.getChild('CompareOp');
    const left = n.firstChild;
    const right = n.lastChild;
    if (op && left && right && right !== left) {
      const opText = text(src, op);
      if ((opText === '==' || opText === '!=')) {
        const isString = (x: SyntaxNode) => x.name === 'StringLiteral' || (x.name === 'Identifier' && scope.get(text(src, x)) === 'String');
        if (isString(left) || isString(right)) push(n, 'warning', `Strings compared with '${opText}' compare references, not text: use ${opText === '!=' ? '!' : ''}a.equals(b)`);
      }
      if (sameText(src, left, right) && (left.name === 'Identifier' || /Literal$/.test(left.name))) {
        const always = opText === '==' || opText === '<=' || opText === '>=' ? 'true' : 'false';
        push(n, 'warning', `'${text(src, n)}' is always ${always}`);
      } else if (/Literal$/.test(left.name) && /Literal$/.test(right.name) && left.name !== 'StringLiteral') {
        push(n, 'warning', `Both sides are constants: '${text(src, n)}' is always the same`);
      }
    }
  }
  if (n.name === 'Block' || n.name === 'ConstructorBody' || n.name === 'SwitchBlock') {
    let dead = false;
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.name === '{' || c.name === '}' || c.name === 'LineComment' || c.name === 'BlockComment') continue;
      if (n.name === 'SwitchBlock') { if (c.name === 'SwitchLabel' || c.name === 'SwitchRule' || c.name === 'SwitchSection') dead = false; continue; }
      if (dead) { push(c, 'error', 'Unreachable statement: the code above always returns, throws or jumps'); break; }
      if (['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(c.name)) dead = true;
    }
  }
  if (n.name === 'TypeName') {
    const t = text(src, n);
    if (TYPO_TYPES[t] && n.parent && n.parent.name !== 'FieldAccess' && n.parent.name !== 'ScopedTypeName') push(n, 'error', `Unknown type '${t}': Java spells it '${TYPO_TYPES[t]}'`);
  }
  if (n.name === 'FieldAccess') {
    const obj = n.firstChild;
    const field = n.lastChild;
    if (obj && field && field.name === 'Identifier' && obj.name === 'Identifier') {
      const name = text(src, obj);
      const f = text(src, field);
      if (TYPO_SYSTEM[name]) push(obj, 'error', `Cannot find '${name}': did you mean 'System'?`);
      const known = scope.get(name);
      // Only a plain field access: "s.length" as a value, not a method's receiver
      if (!(n.parent && n.parent.name === 'MethodInvocation' && n.parent.firstChild === n)) {
        if (known === 'String' && f === 'length') push(field, 'error', "'length' is a method on String: write length()");
        else if (known === 'List' && (f === 'length' || f === 'size')) push(field, 'error', `A List has no '${f}' field: write size()`);
        else if (known === 'array' && f !== 'length' && f !== 'clone') push(field, 'error', `An array has only 'length': '${f}' does not exist`);
      }
    }
  }
  if (n.name === 'MethodInvocation') {
    const receiver = n.firstChild;
    const method = n.getChild('MethodName');
    const m = text(src, method);
    if (!receiver || !method || receiver === method) return;
    let type: Known | null = null;
    if (receiver.name === 'StringLiteral') type = 'String';
    else if (receiver.name === 'Identifier') type = scope.get(text(src, receiver));
    else if (receiver.name === 'FieldAccess' && /^System\.(out|err)$/.test(text(src, receiver))) {
      if (!PRINT_STREAM_METHODS.has(m)) push(method, 'error', `Cannot find method '${m}' on ${text(src, receiver)}: did you mean println()?`);
      return;
    }
    if (type === 'array') push(method, 'error', m === 'length' ? "Arrays have no length() method: write length without parentheses" : `An array has no '${m}()' method`);
    else if (type === 'String' && !STRING_METHODS.has(m)) push(method, 'error', m === 'size' ? "A String has no size(): write length()" : `Cannot find method '${m}()' on String`);
    else if (type === 'List' && !LIST_METHODS.has(m)) push(method, 'error', m === 'length' ? "A List has no length(): write size()" : `Cannot find method '${m}()' on List`);
    else if (type === 'Map' && !MAP_METHODS.has(m)) push(method, 'error', m === 'add' ? "A Map has no add(): write put(key, value)" : `Cannot find method '${m}()' on Map`);
  }
}

// Diagnostics as line/column text, for tests and logs: "3:5 error Missing ';'"
export const describe = (src: string, d: JavaDiagnostic): string => {
  const before = src.slice(0, d.from);
  const line = before.split('\n').length;
  const col = d.from - before.lastIndexOf('\n');
  return `${line}:${col} ${d.severity} ${d.message}`;
};
