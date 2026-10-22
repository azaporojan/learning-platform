// Static checks shown in notebook code cells (notebooks/javaLint.ts). Run: npm test --prefix client
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintJava, topLevelChunks, describe } from '../notebooks/javaLint.ts';

const lines = (src: string) => lintJava(src).map((d) => describe(src, d));

test('top-level chunks split on ; and } but keep else/catch/do-while together', () => {
  const src = 'int a = 1;\nif (a > 0) {\n  a++;\n} else {\n  a--;\n}\ndo { a++; } while (a < 3);\nvoid f() { return; }\ntry { f(); } catch (Exception e) { } finally { }';
  assert.deepEqual(topLevelChunks(src).map((c) => src.slice(c.from, c.to).trim().split('\n')[0]),
    ['int a = 1;', 'if (a > 0) {', 'do { a++; } while (a < 3);', 'void f() { return; }', 'try { f(); } catch (Exception e) { } finally { }']);
});

test('missing semicolon between statements, but not on the last line (JShell shows that value)', () => {
  assert.deepEqual(lines('int a = 5\nint b = 6;'), ["1:9 error Missing ';' between two statements"]);
  assert.deepEqual(lines('System.out.println("hi")'), []);
  assert.deepEqual(lines('int a = 5;\na + 1'), []);
  assert.deepEqual(lines('int a = 5;\nSystem.out.println(a)\nint b = 1;'), ["2:20 error Missing ';' between two statements"]);
});

test('unclosed brackets and braces', () => {
  assert.deepEqual(lines('if (a > b) {\n  a++;\n'), ["2:6 error Missing '}': this block is never closed"]);
  assert.deepEqual(lines('System.out.println("x";'), ["1:20 error Syntax error: missing ')'?"]);
  assert.deepEqual(lines('foo(;'), ["1:4 error Syntax error: missing ')'?"]);
  assert.deepEqual(lines('int x = (1 + 2;'), ["1:14 error Syntax error: missing ')'?"]);
});

test('top-level methods and classes are fine in JShell and here', () => {
  assert.deepEqual(lines('int twice(int x) {\n    return x * 2;\n}\ntwice(4)'), []);
  assert.deepEqual(lines('record P(String name, int age) {}\nvar p = new P("a", 1);\np.name()'), []);
  assert.deepEqual(lines('class Dog {\n  String name;\n  Dog(String n) { name = n; }\n  String bark() { return name + " woof"; }\n}\nnew Dog("Rex").bark()'), []);
  assert.deepEqual(lines('static int count = 0;\nvoid inc() { count++; }\ninc();\ncount'), []);
});

test('conditions that are always true or false, assignment in a condition, empty if', () => {
  assert.deepEqual(lines('if (true) { }\nwhile (false) { }\nwhile (true) { break; }'), ['1:5 warning Condition is always true', '2:8 warning Condition is always false']);
  assert.deepEqual(lines('int x = 1;\nif (x == x) { }\nif (3 > 2) { }'), ["2:5 warning 'x == x' is always true", "3:5 warning Both sides are constants: '3 > 2' is always the same"]);
  assert.deepEqual(lines('boolean flag = false;\nif (flag = true) { }'), ["2:5 warning Assignment '=' inside a condition: did you mean '=='?"]);
  assert.deepEqual(lines('int a = 1;\nif (a > 0);\nfor (int i = 0; i < 3; i++);'), ["2:11 warning ';' right after the condition: this if does nothing", "3:28 warning ';' right after the loop header: the loop body is empty"]);
});

test('strings compared with ==', () => {
  assert.deepEqual(lines('String s = "x";\nif (s == "x") { }'), ["2:5 warning Strings compared with '==' compare references, not text: use a.equals(b)"]);
  assert.deepEqual(lines('String a = "x", b = "y";\nboolean same = a != b;'), ["2:16 warning Strings compared with '!=' compare references, not text: use !a.equals(b)"]);
  assert.deepEqual(lines('int a = 1, b = 2;\nif (a == b) { }'), []);
});

test('unreachable statements', () => {
  assert.deepEqual(lines('int f() {\n  return 1;\n  int y = 2;\n}'), ['3:3 error Unreachable statement: the code above always returns, throws or jumps']);
  assert.deepEqual(lines('for (int i = 0; i < 3; i++) {\n  if (i == 1) break;\n  System.out.println(i);\n}'), []);
  assert.deepEqual(lines('switch (x) {\n  case 1: return "a";\n  case 2: return "b";\n  default: return "c";\n}'), []);
});

test('methods that do not exist on String, arrays, List, Map and System.out', () => {
  assert.deepEqual(lines('String s = "abc";\nint n = s.length;\ns.size();\ns.toUpperCase();\n"x".foo();'),
    ["2:11 error 'length' is a method on String: write length()", '3:3 error A String has no size(): write length()', "5:5 error Cannot find method 'foo()' on String"]);
  assert.deepEqual(lines('int[] a = {1, 2};\nint n = a.length();\nint m = a.length;\nint k = a.size;'),
    ['2:11 error Arrays have no length() method: write length without parentheses', "4:11 error An array has only 'length': 'size' does not exist"]);
  assert.deepEqual(lines('List<String> xs = new ArrayList<>();\nxs.length();\nxs.add("a");\nxs.push("b");\nint n = xs.length;'),
    ['2:4 error A List has no length(): write size()', "4:4 error Cannot find method 'push()' on List", "5:12 error A List has no 'length' field: write size()"]);
  assert.deepEqual(lines('var m = new HashMap<String, Integer>();\nm.add("a");\nm.put("a", 1);'), ['2:3 error A Map has no add(): write put(key, value)']);
  assert.deepEqual(lines('System.out.printn("x");\nSytem.out.println("y");'), ["1:12 error Cannot find method 'printn' on System.out: did you mean println()?", "2:1 error Cannot find 'Sytem': did you mean 'System'?"]);
});

test('a name declared with two types, a lambda parameter, or never declared is left alone', () => {
  assert.deepEqual(lines('String s = "a";\n{ int[] s = {1}; }\ns.size();'), []);
  assert.deepEqual(lines('List<String> xs = List.of("a");\nxs.forEach(s -> s.foo());'), []);
  assert.deepEqual(lines('unknown.whatever();\nother.length;'), []);
  assert.deepEqual(lines('var s = "lit";\ns.charAt(0)'), []);
});

test('type names spelt the Python way', () => {
  assert.deepEqual(lines('string s = "x";\nInt k = 1;'), ["1:1 error Unknown type 'string': Java spells it 'String'", "2:1 error Unknown type 'Int': Java spells it 'int'"]);
});

test('strings, comments and text blocks do not confuse the chunker', () => {
  assert.deepEqual(lines('String s = "a;b{"; // x;\n/* ; { */\nString t = """\n  {;\n  """;\nchar c = \';\';\ns.length()'), []);
});
