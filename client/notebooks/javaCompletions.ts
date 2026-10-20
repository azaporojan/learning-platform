import { CompletionContext, CompletionResult, Completion, snippetCompletion, completeAnyWord } from '@codemirror/autocomplete';

// A small static index of the JDK and the libraries in the sandbox (JUnit 5, AssertJ), enough to
// suggest the names a course uses without a language server. After "Type." it offers that type's
// static members; after "expr." the instance methods of common types.

const STATICS: Record<string, string[]> = {
  System: ['out', 'err', 'currentTimeMillis()', 'nanoTime()', 'getProperty()', 'lineSeparator()'],
  Math: ['abs()', 'max()', 'min()', 'pow()', 'sqrt()', 'round()', 'floor()', 'ceil()', 'random()', 'floorMod()', 'PI'],
  List: ['of()', 'copyOf()'],
  Set: ['of()', 'copyOf()'],
  Map: ['of()', 'entry()', 'copyOf()', 'ofEntries()'],
  Arrays: ['asList()', 'sort()', 'toString()', 'stream()', 'fill()', 'copyOf()', 'equals()', 'deepToString()'],
  Collections: ['sort()', 'reverse()', 'shuffle()', 'max()', 'min()', 'unmodifiableList()', 'emptyList()', 'frequency()'],
  Collectors: ['toList()', 'toSet()', 'toMap()', 'joining()', 'groupingBy()', 'counting()', 'partitioningBy()', 'summingInt()', 'averagingInt()', 'mapping()'],
  Stream: ['of()', 'iterate()', 'generate()', 'concat()', 'empty()'],
  IntStream: ['range()', 'rangeClosed()', 'of()', 'iterate()'],
  Optional: ['of()', 'ofNullable()', 'empty()'],
  String: ['valueOf()', 'format()', 'join()'],
  Integer: ['parseInt()', 'valueOf()', 'MAX_VALUE', 'MIN_VALUE', 'compare()', 'toBinaryString()'],
  Double: ['parseDouble()', 'valueOf()', 'compare()'],
  Boolean: ['parseBoolean()'],
  LocalDate: ['now()', 'of()', 'parse()'],
  LocalDateTime: ['now()', 'of()', 'parse()'],
  Duration: ['ofSeconds()', 'ofMillis()', 'ofMinutes()', 'between()'],
  Files: ['readString()', 'writeString()', 'readAllLines()', 'exists()', 'lines()'],
  Path: ['of()'],
  Objects: ['equals()', 'hash()', 'requireNonNull()', 'isNull()', 'nonNull()', 'toString()'],
  Assertions: ['assertThat()', 'assertThatThrownBy()', 'assertEquals()', 'assertTrue()', 'assertFalse()', 'assertThrows()', 'assertNotNull()', 'fail()'],
  ThreadLocalRandom: ['current()'],
  Comparator: ['comparing()', 'comparingInt()', 'naturalOrder()', 'reverseOrder()'],
};

const INSTANCE: string[] = [
  // String
  'length()', 'charAt()', 'substring()', 'indexOf()', 'lastIndexOf()', 'contains()', 'startsWith()', 'endsWith()', 'equals()', 'equalsIgnoreCase()',
  'isEmpty()', 'isBlank()', 'trim()', 'strip()', 'toUpperCase()', 'toLowerCase()', 'replace()', 'split()', 'chars()', 'repeat()', 'formatted()', 'lines()', 'compareTo()',
  // Collections
  'add()', 'addAll()', 'get()', 'set()', 'remove()', 'size()', 'clear()', 'containsKey()', 'containsValue()', 'put()', 'putIfAbsent()', 'getOrDefault()',
  'keySet()', 'values()', 'entrySet()', 'getKey()', 'getValue()', 'forEach()', 'iterator()', 'sort()', 'stream()', 'toArray()', 'indexOf()', 'subList()', 'merge()', 'computeIfAbsent()',
  // Streams
  'filter()', 'map()', 'mapToInt()', 'mapToObj()', 'flatMap()', 'distinct()', 'sorted()', 'limit()', 'skip()', 'peek()', 'reduce()', 'collect()', 'toList()',
  'count()', 'sum()', 'average()', 'min()', 'max()', 'anyMatch()', 'allMatch()', 'noneMatch()', 'findFirst()', 'findAny()', 'boxed()', 'getAsInt()', 'getAsDouble()',
  // Optional
  'isPresent()', 'ifPresent()', 'orElse()', 'orElseGet()', 'orElseThrow()',
  // Object / misc
  'toString()', 'hashCode()', 'getClass()', 'getMessage()', 'printStackTrace()', 'println()', 'print()', 'printf()', 'plusDays()', 'minusDays()', 'getYear()', 'isBefore()', 'isAfter()',
  // AssertJ
  'isEqualTo()', 'isNotEqualTo()', 'isTrue()', 'isFalse()', 'isNull()', 'isNotNull()', 'hasSize()', 'contains()', 'containsExactly()', 'containsExactlyInAnyOrder()', 'containsOnly()',
  'doesNotContain()', 'isEmpty()', 'isNotEmpty()', 'isGreaterThan()', 'isLessThan()', 'isBetween()', 'startsWith()', 'endsWith()', 'matches()', 'extracting()', 'isInstanceOf()',
  'hasMessage()', 'hasMessageContaining()', 'isInstanceOfAny()', 'as()', 'describedAs()', 'allSatisfy()', 'anySatisfy()',
];

const KEYWORDS = ['var', 'final', 'record', 'class', 'interface', 'enum', 'public', 'private', 'static', 'void', 'return', 'new', 'if', 'else', 'for', 'while',
  'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'import', 'instanceof', 'null', 'true', 'false', 'this', 'extends', 'implements'];

const TYPES = [...Object.keys(STATICS), 'ArrayList', 'HashMap', 'HashSet', 'LinkedList', 'TreeMap', 'LinkedHashMap', 'ArrayDeque', 'StringBuilder', 'Scanner', 'Random',
  'Exception', 'RuntimeException', 'IllegalArgumentException', 'IllegalStateException', 'NullPointerException', 'Function', 'Predicate', 'Supplier', 'Consumer', 'BiFunction', 'Record'];

const SNIPPETS: Completion[] = [
  snippetCompletion('System.out.println(${})', { label: 'sout', detail: 'System.out.println', type: 'function' }),
  snippetCompletion('for (int ${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}', { label: 'fori', detail: 'for loop', type: 'keyword' }),
  snippetCompletion('for (var ${item} : ${items}) {\n\t${}\n}', { label: 'foreach', detail: 'for-each loop', type: 'keyword' }),
  snippetCompletion('record ${Name}(${String name}) {}', { label: 'record', detail: 'record declaration', type: 'keyword' }),
  snippetCompletion('assertThat(${actual}).isEqualTo(${expected});', { label: 'assertThat', detail: 'AssertJ', type: 'function' }),
];

const toCompletion = (name: string, type: string): Completion => (name.endsWith('()')
  ? { label: name.slice(0, -2), type: 'method', apply: name.slice(0, -1), detail: '()' }
  : { label: name, type });

const instanceOptions = [...new Set(INSTANCE)].map((m) => toCompletion(m, 'method'));
const globalOptions: Completion[] = [
  ...TYPES.map((t) => ({ label: t, type: 'class' })),
  ...KEYWORDS.map((k) => ({ label: k, type: 'keyword' })),
  ...SNIPPETS,
];

export function javaCompletions(context: CompletionContext): CompletionResult | null | Promise<CompletionResult | null> {
  const member = context.matchBefore(/([A-Za-z_$][\w$]*|\)|\])\s*\.\s*[\w$]*$/);
  if (member) {
    const dot = member.text.lastIndexOf('.');
    const receiver = member.text.slice(0, dot).trim();
    const from = member.from + dot + 1 + (member.text.slice(dot + 1).length - member.text.slice(dot + 1).trimStart().length);
    const statics = STATICS[receiver];
    const options = statics ? statics.map((m) => toCompletion(m, /^[A-Z_]+$/.test(m) ? 'constant' : 'method')) : instanceOptions;
    return { from, options, validFor: /^[\w$]*$/ };
  }
  const word = context.matchBefore(/[A-Za-z_$][\w$]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const local = completeAnyWord(context) as CompletionResult | null;
  const locals = (local && local.options) || [];
  return { from: word.from, options: [...globalOptions, ...locals.filter((o) => !globalOptions.some((g) => g.label === o.label))], validFor: /^[\w$]*$/ };
}
