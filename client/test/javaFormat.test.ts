// Ctrl+Alt+L in notebook cells (notebooks/javaFormat.ts). Run: npm test --prefix client
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJava, formatJavaLines } from '../notebooks/javaFormat.ts';

const cases: [string, string, string][] = [
  ['spacing around operators, keywords and braces',
    'int a=5,b=-3;\nif(a>b){a++;}else{b--;}\nfor(int i=0;i<10;i++){\nsum+=i*2;\n}',
    'int a = 5, b = -3;\nif (a > b) { a++; } else { b--; }\nfor (int i = 0; i < 10; i++) {\n    sum += i * 2;\n}'],
  ['generics stay tight, comparisons get spaces',
    'Map<String,List<Integer>> m=new HashMap<>();\nList<int[]> l=new ArrayList<>();\nif(arr[i]>x&&n<MAX)y=1;',
    'Map<String, List<Integer>> m = new HashMap<>();\nList<int[]> l = new ArrayList<>();\nif (arr[i] > x && n < MAX) y = 1;'],
  ['chained calls and lambdas',
    'users.stream()\n.filter(u->u.age()>=18)\n.map(User::name)\n.toList()',
    'users.stream()\n        .filter(u -> u.age() >= 18)\n        .map(User::name)\n        .toList()'],
  ['switch cases are indented once more',
    'switch(day){\ncase 1:\nprint("Mon");\nbreak;\ncase 2 -> print("x");\ndefault:\nprint("?");\n}',
    'switch (day) {\n    case 1:\n        print("Mon");\n        break;\n    case 2 -> print("x");\n    default:\n        print("?");\n}'],
  ['array initializers, casts, unary minus',
    'int[][] g={{1,2},{3,4}};\nint[] a=new int[]{1,2};\nint x=(int)3.5;\nx=-x+ -1;\ny=a*(b+c)-(d);',
    'int[][] g = {{1, 2}, {3, 4}};\nint[] a = new int[]{1, 2};\nint x = (int) 3.5;\nx = -x + -1;\ny = a * (b + c) - (d);'],
  ['strings, chars, comments and text blocks are left alone',
    'String s="a+b{";char c=\'{\';// x=y+1\nString t = """\n    {keep  this}\n    """;\n/* a {\n   b */',
    'String s = "a+b{"; char c = \'{\'; // x=y+1\nString t = """\n    {keep  this}\n    """;\n/* a {\n   b */'],
  ['trailing spaces and extra blank lines go',
    'int a = 1;   \n\n\n\nint b = 2;\n\n',
    'int a = 1;\n\nint b = 2;'],
];

for (const [name, input, expected] of cases) {
  test(name, () => {
    const out = formatJava(input);
    assert.equal(out, expected);
    assert.equal(formatJava(out), out, 'formatting twice changes nothing');
  });
}

test('a selection is formatted in the context of the whole cell (same lines, right depth)', () => {
  const src = 'for(int i=0;i<3;i++){\nif(i>1){\nx+=i;\n}\n\n\n}';
  const lines = formatJavaLines(src);
  assert.equal(lines.length, src.split('\n').length, 'one output line per input line');
  // Lines 2-4 (the nested if) keep their depth inside the loop
  assert.deepEqual(lines.slice(1, 4), ['    if (i > 1) {', '        x += i;', '    }']);
});
