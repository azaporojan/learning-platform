package lp;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URI;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.FileObject;
import javax.tools.ForwardingJavaFileManager;
import javax.tools.JavaFileManager;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

import jdk.jshell.DeclarationSnippet;
import jdk.jshell.EvalException;
import jdk.jshell.JShell;
import jdk.jshell.Snippet;
import jdk.jshell.SnippetEvent;
import jdk.jshell.SourceCodeAnalysis;
import jdk.jshell.UnresolvedReferenceException;

import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.engine.discovery.DiscoverySelectors;
import org.junit.platform.launcher.Launcher;
import org.junit.platform.launcher.LauncherDiscoveryRequest;
import org.junit.platform.launcher.TestExecutionListener;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;

/**
 * The sandbox kernel. Runs inside a throwaway, network-less container and talks to the runner
 * over stdin/stdout.
 *
 * <pre>
 *   java lp.Kernel jshell   notebook cells (one JShell, state kept between cells until exit)
 *   java lp.Kernel check    compile student files + hidden JUnit tests, run the tests
 * </pre>
 *
 * Protocol, one line per message, UTF-8:
 * <pre>
 *   in   NONCE &lt;hex&gt;                   first line, always
 *   in   CELL &lt;id&gt; &lt;base64 source&gt; [&lt;base64 input&gt;]
 *                                      jshell: evaluate one cell; the input, if any, is its System.in
 *   in   FILE &lt;b64 path&gt; &lt;b64 source&gt;   check: a student file
 *   in   TEST &lt;b64 path&gt; &lt;b64 source&gt;   check: a hidden test file
 *   in   END                          jshell: exit after the last cell; check: start
 *   out  \u001eLP &lt;nonce&gt; &lt;json&gt;          a result; anything else on stdout is ignored
 * </pre>
 * The nonce lets the runner ignore lines that student code prints to the real stdout. It is read
 * from stdin before any student code runs and lives only in this class.
 */
public final class Kernel {
    static final int MAX_OUTPUT = 64 * 1024;
    private static final Pattern SAFE_PATH = Pattern.compile("[A-Za-z0-9_$-]+(/[A-Za-z0-9_$-]+)*\\.java");
    private static final Path LIBS = Path.of(System.getProperty("lp.libs", "/opt/lp/libs"));
    private static final Path WORK = Path.of(System.getProperty("lp.work", "/work"));

    private Kernel() {}

    /**
     * The result channel. It is only ever held in local variables of the kernel's own frames
     * (never in a static field), so student code running in this JVM has no reference path to
     * the nonce through reflection.
     */
    private static final class Channel {
        private final PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        private final String prefix;

        Channel(String nonce) { this.prefix = "\u001eLP " + nonce + " "; }

        synchronized void emit(Map<String, ?> message) {
            out.print(prefix);
            out.println(Json.write(message));
            out.flush();
        }
    }

    private static Channel open(BufferedReader in) throws IOException {
        String first = in.readLine();
        if (first == null || !first.startsWith("NONCE ")) return null;
        return new Channel(first.substring(6).trim());
    }

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        // Student code must never read the protocol stream
        System.setIn(new ByteArrayInputStream(new byte[0]));
        String mode = args.length > 0 ? args[0] : "jshell";
        if ("selftest".equals(mode)) {
            selfTest();
            return;
        }
        if ("check".equals(mode)) {
            Channel channel = open(in);
            if (channel != null) runCheck(in, channel);
            Runtime.getRuntime().halt(0);
        }
        // jshell: boot and warm up before the nonce arrives, so a pre-started container answers fast
        try (Notebook nb = new Notebook()) {
            Channel channel = open(in);
            if (channel == null) return;
            channel.emit(Map.of("type", "ready"));
            String line;
            while ((line = in.readLine()) != null) {
                if (line.equals("END")) break;
                if (line.equals("PING")) { channel.emit(Map.of("type", "pong")); continue; }
                if (!line.startsWith("CELL ")) continue;
                String[] parts = line.split(" ", 4);
                if (parts.length < 3) continue;
                String source = new String(Base64.getDecoder().decode(parts[2].trim()), StandardCharsets.UTF_8);
                byte[] input = parts.length > 3 ? Base64.getDecoder().decode(parts[3].trim()) : new byte[0];
                channel.emit(nb.run(parts[1], source, input));
            }
        }
        // A stray non-daemon thread started by a cell must not keep the container alive
        Runtime.getRuntime().halt(0);
    }

    /** Builds the AppCDS archive at image build time and proves the image works. */
    private static void selfTest() throws Exception {
        try (Notebook nb = new Notebook()) {
            Map<String, Object> r = nb.run("1", "record P(int x) {}\nvar ps = List.of(new P(1), new P(2));\nps.stream().map(P::x).toList()", new byte[0]);
            if (!"ok".equals(r.get("status"))) throw new IllegalStateException("self-test failed: " + r);
            Map<String, Object> a = nb.run("2", "assertThat(ps).hasSize(2);", new byte[0]);
            Map<String, Object> in = nb.run("3", "new Scanner(System.in).nextInt() * 2", "21\n".getBytes(StandardCharsets.UTF_8));
            if (!"42".equals(in.get("value"))) throw new IllegalStateException("input self-test failed: " + in);
            if (!"ok".equals(a.get("status"))) throw new IllegalStateException("assertj self-test failed: " + a);
            System.err.println("selftest ok: " + r.get("value"));
        }
    }

    // ------------------------------------------------------------------------------------------
    // Output capture: one bounded buffer per cell, shared by System.out and System.err
    // ------------------------------------------------------------------------------------------
    static final class Capture {
        final ByteArrayOutputStream out = new ByteArrayOutputStream();
        final ByteArrayOutputStream err = new ByteArrayOutputStream();
        int total;
        boolean truncated;

        PrintStream stream(ByteArrayOutputStream target) {
            OutputStream bounded = new OutputStream() {
                @Override public void write(int b) { write(new byte[] {(byte) b}, 0, 1); }
                @Override public void write(byte[] b, int off, int len) {
                    synchronized (Capture.this) {
                        int room = MAX_OUTPUT - total;
                        if (room <= 0) { truncated = true; return; }
                        int n = Math.min(room, len);
                        target.write(b, off, n);
                        total += n;
                        if (n < len) truncated = true;
                    }
                }
            };
            return new PrintStream(bounded, true, StandardCharsets.UTF_8);
        }

        synchronized String out() { return out.toString(StandardCharsets.UTF_8); }
        synchronized String err() { return err.toString(StandardCharsets.UTF_8); }
    }

    // ------------------------------------------------------------------------------------------
    // Notebook: one JShell with local execution (a single JVM), cells evaluated snippet by snippet
    // ------------------------------------------------------------------------------------------
    static final class Notebook implements AutoCloseable {
        private static final List<String> IMPORTS = List.of(
            "import java.util.*;", "import java.util.function.*;", "import java.util.stream.*;",
            "import java.io.*;", "import java.math.*;", "import java.time.*;", "import java.nio.file.*;",
            "import static org.assertj.core.api.Assertions.*;");

        private final JShell shell;
        private final SourceCodeAnalysis analysis;
        private final PrintStream realOut = System.out;
        private final PrintStream realErr = System.err;
        private Capture capture = new Capture();

        Notebook() {
            // Output is routed through System.out/err, which run() points at the cell's capture
            PrintStream toOut = new PrintStream(new OutputStream() {
                @Override public void write(int b) { System.out.write(b); }
                @Override public void write(byte[] b, int off, int len) { System.out.write(b, off, len); }
            }, true, StandardCharsets.UTF_8);
            PrintStream toErr = new PrintStream(new OutputStream() {
                @Override public void write(int b) { System.err.write(b); }
                @Override public void write(byte[] b, int off, int len) { System.err.write(b, off, len); }
            }, true, StandardCharsets.UTF_8);
            String classpath = classpath();
            shell = JShell.builder()
                .executionEngine("local")
                .out(toOut).err(toErr)
                .compilerOptions("-Xlint:none")
                .build();
            if (!classpath.isEmpty()) {
                for (String entry : classpath.split(java.io.File.pathSeparator)) shell.addToClasspath(entry);
            }
            analysis = shell.sourceCodeAnalysis();
            for (String imp : IMPORTS) shell.eval(imp);
            // Warm the compiler and the lambda machinery so the first real cell is fast
            for (String warm : List.of("int warm$ = 1 + 1;", "List.of(1, 2).stream().map(x -> x * 2).toList()")) {
                for (SnippetEvent ev : shell.eval(warm)) shell.drop(ev.snippet());
            }
        }

        /** Evaluates one cell; {@code input} is what System.in reads during this cell (and only this cell). */
        Map<String, Object> run(String id, String source, byte[] input) {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "cell");
            result.put("id", id);
            capture = new Capture();
            System.setIn(new ByteArrayInputStream(input));
            System.setOut(capture.stream(capture.out));
            System.setErr(capture.stream(capture.err));
            long started = System.nanoTime();
            Map<String, Object> error = null;
            String value = null;
            try {
                String remaining = source;
                int consumed = 0;
                while (!remaining.isBlank()) {
                    int lead = leadingWhitespace(remaining);
                    SourceCodeAnalysis.CompletionInfo info = analysis.analyzeCompletion(remaining);
                    SourceCodeAnalysis.Completeness c = info.completeness();
                    if (c == SourceCodeAnalysis.Completeness.EMPTY) break;
                    String snippetSource;
                    // The snippet's first code character (stack-trace lines count from here);
                    // javac positions count from the untrimmed snippet source, i.e. from 'consumed'
                    int snippetStart = consumed + lead;
                    int rawStart = consumed;
                    if (c.isComplete()) {
                        snippetSource = info.source();
                        consumed += remaining.length() - info.remaining().length();
                        remaining = info.remaining();
                    } else if (c == SourceCodeAnalysis.Completeness.UNKNOWN) {
                        snippetSource = remaining;
                        consumed += remaining.length();
                        remaining = "";
                    } else {
                        error = errorOf("compile", "The cell ends in the middle of a statement: a missing ';', ')' or '}'?",
                            lineAt(source, source.length()));
                        break;
                    }
                    value = null;
                    for (SnippetEvent ev : shell.eval(snippetSource)) {
                        if (ev.causeSnippet() != null) continue;
                        Snippet s = ev.snippet();
                        if (ev.status() == Snippet.Status.REJECTED) {
                            error = compileError(s, source, rawStart);
                            break;
                        }
                        if (ev.exception() != null) {
                            error = runtimeError(ev.exception(), s, lineAt(source, snippetStart));
                            break;
                        }
                        if ((ev.status() == Snippet.Status.RECOVERABLE_DEFINED || ev.status() == Snippet.Status.RECOVERABLE_NOT_DEFINED)
                            && s instanceof DeclarationSnippet d) {
                            String missing = shell.unresolvedDependencies(d).collect(Collectors.joining(", "));
                            error = errorOf("compile", "cannot find symbol: " + missing, lineAt(source, snippetStart));
                            break;
                        }
                        if (s.kind() == Snippet.Kind.EXPRESSION
                            || (s.kind() == Snippet.Kind.VAR && s.subKind() == Snippet.SubKind.TEMP_VAR_EXPRESSION_SUBKIND)) {
                            value = ev.value();
                        }
                    }
                    if (error != null) break;
                }
            } catch (Throwable t) {
                error = errorOf("internal", t.toString(), null);
            } finally {
                System.out.flush();
                System.err.flush();
                System.setOut(realOut);
                System.setErr(realErr);
                System.setIn(new ByteArrayInputStream(new byte[0]));
            }
            // Explain input problems, but only when Scanner itself threw (its frames are in the trace),
            // so an Optional.get() or an iterator in the same cell keeps its own plain message
            if (error != null && "runtime".equals(error.get("kind"))) {
                String text = String.valueOf(error.get("message"));
                if (text.contains("at java.base/java.util.Scanner.") || text.contains("at java.util.Scanner.")) {
                    String hint = null;
                    if (text.startsWith("java.util.InputMismatchException")) {
                        hint = "The input does not match what the code reads: for example nextInt() found a word. Check the Input box.";
                    } else if (text.startsWith("java.util.NoSuchElementException")) {
                        hint = input.length == 0
                            ? "This cell reads input, but its Input box is empty. Type the input there, one value per line."
                            : "The cell's input ran out: it read more values than its Input box holds.";
                    }
                    if (hint != null) error.put("message", hint + "\n\n" + text);
                }
            }
            result.put("status", error == null ? "ok" : "error");
            result.put("stdout", capture.out());
            result.put("stderr", capture.err());
            result.put("value", error == null ? value : null);
            result.put("error", error);
            result.put("truncated", capture.truncated);
            result.put("durationMs", (System.nanoTime() - started) / 1_000_000);
            return result;
        }

        /** snippetStart: offset in the cell of the snippet source as given to javac (whitespace included). */
        private Map<String, Object> compileError(Snippet s, String cell, int snippetStart) {
            List<jdk.jshell.Diag> diags = shell.diagnostics(s)
                .filter(jdk.jshell.Diag::isError).collect(Collectors.toList());
            if (diags.isEmpty()) return errorOf("compile", "This code does not compile", lineAt(cell, snippetStart));
            jdk.jshell.Diag d = diags.get(0);
            long pos = Math.max(0, d.getStartPosition());
            String message = d.getMessage(Locale.ENGLISH);
            int start = snippetStart + (int) Math.min(pos, Integer.MAX_VALUE - snippetStart);
            Map<String, Object> err = errorOf("compile", message, lineAt(cell, start));
            // The token javac pointed at, so the editor can underline it (1-based columns)
            err.put("column", columnAt(cell, start));
            if (d.getEndPosition() > d.getStartPosition()) {
                int end = snippetStart + (int) Math.min(d.getEndPosition(), Integer.MAX_VALUE - snippetStart);
                err.put("endLine", lineAt(cell, end));
                err.put("endColumn", columnAt(cell, end));
            }
            return err;
        }

        private static Map<String, Object> runtimeError(Exception e, Snippet s, int snippetLine) {
            String cls;
            String msg;
            if (e instanceof EvalException ee) {
                cls = ee.getExceptionClassName();
                msg = ee.getMessage();
            } else if (e instanceof UnresolvedReferenceException ure) {
                return errorOf("compile", "cannot use " + ure.getSnippet().source().strip().split("\\R", 2)[0]
                    + " yet: something it depends on is not defined", null);
            } else {
                cls = e.getClass().getName();
                msg = e.getMessage();
            }
            StringBuilder text = new StringBuilder(cls);
            if (msg != null) text.append(": ").append(msg);
            // Snippet frames carry the snippet id as file name ("#12") and a line inside the snippet
            String ownFile = "#" + s.id();
            Integer line = null;
            for (StackTraceElement el : e.getStackTrace()) {
                String c = el.getClassName();
                String file = el.getFileName();
                if (c.startsWith("jdk.jshell.") || c.startsWith("jdk.internal.") || c.startsWith("java.lang.reflect.")
                    || c.startsWith("lp.")) continue;
                if (file != null && file.startsWith("#")) {
                    String method = el.getMethodName() == null || el.getMethodName().isEmpty() ? null : el.getMethodName();
                    if (file.equals(ownFile) && el.getLineNumber() > 0) {
                        int cellLine = snippetLine + el.getLineNumber() - 1;
                        if (line == null) line = cellLine;
                        text.append("\n    at ").append(method == null ? "" : method + ", ").append("line ").append(cellLine);
                    } else {
                        text.append("\n    at ").append(method == null ? "an earlier cell" : method + " (earlier cell)");
                    }
                } else {
                    text.append("\n    at ").append(el);
                }
            }
            Throwable cause = e.getCause();
            int depth = 0;
            while (cause != null && depth++ < 3) {
                text.append("\nCaused by: ").append(cause);
                cause = cause.getCause();
            }
            Map<String, Object> err = errorOf("runtime", text.toString(), line);
            err.put("exception", cls);
            return err;
        }

        @Override public void close() { shell.close(); }
    }

    static Map<String, Object> errorOf(String kind, String message, Integer line) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("kind", kind);
        e.put("message", message);
        e.put("line", line);
        return e;
    }

    static int leadingWhitespace(String s) {
        int i = 0;
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        return i;
    }

    /** 1-based column of a character offset in the cell. */
    static Integer columnAt(String text, int offset) {
        int end = Math.max(0, Math.min(offset, text.length()));
        int lineStart = text.lastIndexOf('\n', end - 1) + 1;
        return end - lineStart + 1;
    }

    /** 1-based line of a character offset in the cell. */
    static Integer lineAt(String text, int offset) {
        int end = Math.max(0, Math.min(offset, text.length()));
        int line = 1;
        for (int i = 0; i < end; i++) if (text.charAt(i) == '\n') line++;
        return line;
    }

    static String classpath() {
        try (Stream<Path> files = Files.list(LIBS)) {
            return files.filter(p -> p.toString().endsWith(".jar")).sorted()
                .map(Path::toString).collect(Collectors.joining(java.io.File.pathSeparator));
        } catch (IOException e) {
            return "";
        }
    }

    // ------------------------------------------------------------------------------------------
    // Check: compile the student's files, then the hidden tests against them, run the tests.
    // The hidden tests never touch the filesystem: they are compiled in memory, defined by a
    // loader that serves no resources, and their bytes are dropped once loaded. Only the tests
    // discovered before any student code runs are counted, each exactly once.
    // ------------------------------------------------------------------------------------------
    private static void runCheck(BufferedReader in, Channel channel) throws Exception {
        Path src = WORK.resolve("src");
        Path classes = WORK.resolve("classes");
        for (Path p : List.of(src, classes)) Files.createDirectories(p);
        List<Path> studentFiles = new ArrayList<>();
        Map<String, String> testSources = new LinkedHashMap<>();
        String line;
        while ((line = in.readLine()) != null && !line.equals("END")) {
            String[] parts = line.split(" ", 3);
            if (parts.length < 3 || !(parts[0].equals("FILE") || parts[0].equals("TEST"))) continue;
            String rel = new String(Base64.getDecoder().decode(parts[1]), StandardCharsets.UTF_8);
            if (!SAFE_PATH.matcher(rel).matches()) {
                channel.emit(checkResult("error", "Invalid file name: " + rel, null, null, null));
                return;
            }
            byte[] content = Base64.getDecoder().decode(parts[2].trim());
            if (parts[0].equals("TEST")) {
                testSources.put(rel, new String(content, StandardCharsets.UTF_8));
            } else {
                Path target = src.resolve(rel).normalize();
                Files.createDirectories(target.getParent());
                Files.write(target, content);
                studentFiles.add(target);
            }
        }
        long started = System.nanoTime();
        Capture capture = new Capture();
        PrintStream realOut = System.out;
        PrintStream realErr = System.err;
        String libs = classpath();
        try {
            List<Map<String, Object>> diags = compileStudent(studentFiles, classes, libs, src);
            if (!diags.isEmpty()) {
                channel.emit(checkResult("compile_error", "Your code does not compile.", diags, null, elapsed(started)));
                return;
            }
            Map<String, byte[]> testBytes = new LinkedHashMap<>();
            diags = compileHidden(testSources, libs + java.io.File.pathSeparator + classes, testBytes);
            testSources.clear();
            if (!diags.isEmpty()) {
                channel.emit(checkResult("compile_error",
                    "Your code compiles, but the tests cannot use it. Check class and method names, parameters and return types against the task.",
                    diags, null, elapsed(started)));
                return;
            }

            Results results = new Results();
            try (URLClassLoader student = new URLClassLoader(new URL[] { classes.toUri().toURL() }, Kernel.class.getClassLoader())) {
                HiddenTestLoader loader = new HiddenTestLoader(testBytes, student);
                // Define every hidden class now (without initialising it), then forget the bytes
                List<Class<?>> topLevel = new ArrayList<>();
                for (String name : new ArrayList<>(testBytes.keySet())) {
                    Class<?> c = loader.loadClass(name);
                    if (!name.contains("$")) topLevel.add(c);
                }
                testBytes.clear();
                loader.forget();
                Thread.currentThread().setContextClassLoader(loader);
                LauncherDiscoveryRequest request = LauncherDiscoveryRequestBuilder.request()
                    .selectors(topLevel.stream().map(DiscoverySelectors::selectClass).toList())
                    .build();
                Launcher launcher = LauncherFactory.create();
                // Discovery reads annotations only; no student code has run yet
                TestPlan plan = launcher.discover(request);
                results.plan(plan);
                System.setOut(capture.stream(capture.out));
                System.setErr(capture.stream(capture.err));
                launcher.execute(plan, results);
            } finally {
                System.setOut(realOut);
                System.setErr(realErr);
            }
            results.finish();
            Map<String, Object> tally = new LinkedHashMap<>();
            tally.put("total", results.total);
            tally.put("passed", results.passed);
            tally.put("failed", results.failures);
            Map<String, Object> r = checkResult(results.total == 0 ? "no_tests" : (results.passed == results.total ? "passed" : "failed"),
                results.total == 0 ? "No tests were found." : results.passed + " of " + results.total + " tests passed.",
                null, tally, elapsed(started));
            r.put("stdout", capture.out());
            r.put("truncated", capture.truncated);
            channel.emit(r);
        } catch (Throwable t) {
            channel.emit(checkResult("error", "The checker failed: " + t, null, null, elapsed(started)));
        }
    }

    /** Defines the hidden test classes from memory. It serves no resources, so their bytes cannot be read back. */
    static final class HiddenTestLoader extends ClassLoader {
        private Map<String, byte[]> bytes;

        HiddenTestLoader(Map<String, byte[]> bytes, ClassLoader parent) {
            super("hidden-tests", parent);
            this.bytes = new HashMap<>(bytes);
        }

        void forget() { bytes = Map.of(); }

        @Override protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            synchronized (getClassLoadingLock(name)) {
                Class<?> c = findLoadedClass(name);
                // Hidden classes first: a student class cannot shadow a test class of the same name
                if (c == null && bytes.containsKey(name)) {
                    byte[] b = bytes.get(name);
                    c = defineClass(name, b, 0, b.length);
                }
                if (c == null) return super.loadClass(name, resolve);
                if (resolve) resolveClass(c);
                return c;
            }
        }
    }

    private static long elapsed(long started) { return (System.nanoTime() - started) / 1_000_000; }

    private static List<String> compileOptions(String cp) {
        return List.of("-cp", cp, "-proc:none", "-Xlint:none", "-encoding", "UTF-8", "-implicit:none");
    }

    private static List<Map<String, Object>> diagnostics(DiagnosticCollector<JavaFileObject> collector, Path root, boolean hidden) {
        List<Map<String, Object>> list = new ArrayList<>();
        for (Diagnostic<? extends JavaFileObject> d : collector.getDiagnostics()) {
            if (d.getKind() != Diagnostic.Kind.ERROR) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            String file = hidden || d.getSource() == null ? null : root.relativize(Path.of(d.getSource().toUri())).toString();
            m.put("file", hidden ? "hidden test" : file);
            m.put("line", hidden ? null : d.getLineNumber());
            m.put("message", d.getMessage(Locale.ENGLISH));
            list.add(m);
            if (list.size() >= 20) break;
        }
        return list;
    }

    private static List<Map<String, Object>> compileStudent(List<Path> files, Path out, String cp, Path root) throws IOException {
        if (files.isEmpty()) return List.of();
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> collector = new DiagnosticCollector<>();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(collector, Locale.ENGLISH, StandardCharsets.UTF_8)) {
            List<String> options = new ArrayList<>(compileOptions(cp));
            options.addAll(List.of("-d", out.toString()));
            Boolean ok = javac.getTask(new StringWriter(), fm, collector, options, null, fm.getJavaFileObjectsFromPaths(files)).call();
            List<Map<String, Object>> list = diagnostics(collector, root, false);
            if (!Boolean.TRUE.equals(ok) && list.isEmpty()) return List.of(Map.of("message", "Compilation failed"));
            return list;
        }
    }

    /** Compiles the hidden tests to class bytes in memory. */
    private static List<Map<String, Object>> compileHidden(Map<String, String> sources, String cp, Map<String, byte[]> out) throws IOException {
        if (sources.isEmpty()) return List.of();
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> collector = new DiagnosticCollector<>();
        Map<String, ByteArrayOutputStream> compiled = new LinkedHashMap<>();
        try (StandardJavaFileManager std = javac.getStandardFileManager(collector, Locale.ENGLISH, StandardCharsets.UTF_8);
             JavaFileManager fm = new ForwardingJavaFileManager<JavaFileManager>(std) {
                 @Override public JavaFileObject getJavaFileForOutput(Location location, String className, JavaFileObject.Kind kind, FileObject sibling) {
                     return new SimpleJavaFileObject(URI.create("mem:///" + className.replace('.', '/') + kind.extension), kind) {
                         @Override public OutputStream openOutputStream() {
                             ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                             compiled.put(className, bytes);
                             return bytes;
                         }
                     };
                 }
             }) {
            List<JavaFileObject> units = new ArrayList<>();
            for (Map.Entry<String, String> e : sources.entrySet()) {
                String content = e.getValue();
                units.add(new SimpleJavaFileObject(URI.create("hidden:///" + e.getKey()), JavaFileObject.Kind.SOURCE) {
                    @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) { return content; }
                });
            }
            Boolean ok = javac.getTask(new StringWriter(), fm, collector, compileOptions(cp), null, units).call();
            List<Map<String, Object>> list = diagnostics(collector, null, true);
            if (!Boolean.TRUE.equals(ok)) return list.isEmpty() ? List.of(Map.of("message", "Compilation failed")) : list;
        }
        for (Map.Entry<String, ByteArrayOutputStream> e : compiled.entrySet()) out.put(e.getKey(), e.getValue().toByteArray());
        return List.of();
    }

    private static Map<String, Object> checkResult(String status, String summary, List<Map<String, Object>> diagnostics,
                                                   Map<String, Object> tests, Long durationMs) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("type", "check");
        r.put("status", status);
        r.put("summary", summary);
        r.put("diagnostics", diagnostics);
        r.put("tests", tests);
        r.put("durationMs", durationMs);
        return r;
    }

    /**
     * Tally of a JUnit run. The planned tests are fixed before student code runs; a result is
     * accepted once per planned test (or per dynamic test under a planned container, such as a
     * parameterized invocation). A planned test that never reports counts as failed.
     */
    static final class Results implements TestExecutionListener {
        int total;
        int passed;
        final List<Map<String, Object>> failures = new ArrayList<>();
        private final Set<String> planned = new HashSet<>();
        private final Set<String> containers = new HashSet<>();
        private final Set<String> done = new HashSet<>();
        private final Map<String, String> names = new HashMap<>();

        void plan(TestPlan plan) {
            for (TestIdentifier root : plan.getRoots()) {
                for (TestIdentifier id : plan.getDescendants(root)) {
                    if (id.isTest()) { planned.add(id.getUniqueId()); names.put(id.getUniqueId(), nameOf(id)); }
                    else containers.add(id.getUniqueId());
                }
            }
        }

        @Override public void dynamicTestRegistered(TestIdentifier id) {
            String parent = id.getParentId().orElse("");
            if (containers.contains(parent) || planned.contains(parent)) {
                if (id.isTest()) { planned.add(id.getUniqueId()); names.put(id.getUniqueId(), nameOf(id)); }
                else containers.add(id.getUniqueId());
            }
        }

        @Override public void executionSkipped(TestIdentifier id, String reason) {
            // @Disabled tests do not count either way
            if (planned.remove(id.getUniqueId())) names.remove(id.getUniqueId());
        }

        @Override public void executionFinished(TestIdentifier id, TestExecutionResult result) {
            if (!id.isTest() || !planned.contains(id.getUniqueId()) || !done.add(id.getUniqueId())) return;
            String message = result.getThrowable().map(t -> {
                String m = t.getMessage();
                return t.getClass().getSimpleName() + (m == null ? "" : ": " + m.strip());
            }).orElse(null);
            record(names.get(id.getUniqueId()), result.getStatus().name(), message);
        }

        void finish() {
            for (String id : planned) if (!done.contains(id)) record(names.get(id), "FAILED", "did not finish");
        }

        private void record(String name, String status, String message) {
            total++;
            if ("SUCCESSFUL".equals(status)) { passed++; return; }
            if (failures.size() >= 50) return;
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("name", name);
            f.put("message", message == null ? status.toLowerCase(Locale.ROOT) : (message.length() > 2000 ? message.substring(0, 2000) + "…" : message));
            failures.add(f);
        }

        private static String nameOf(TestIdentifier id) {
            return id.getSource()
                .filter(s -> s instanceof org.junit.platform.engine.support.descriptor.MethodSource)
                .map(s -> (org.junit.platform.engine.support.descriptor.MethodSource) s)
                .map(m -> {
                    String cls = m.getClassName();
                    String simple = cls.substring(cls.lastIndexOf('.') + 1);
                    String display = id.getDisplayName();
                    return display.startsWith(m.getMethodName() + "(") ? simple + "." + m.getMethodName() : simple + ": " + display;
                })
                .orElse(id.getDisplayName());
        }
    }
}
