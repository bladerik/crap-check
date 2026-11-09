/** Runs a package's test command with coverage. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import picomatch from 'picomatch';
export const DEFAULT_TEST_GLOBS = ['**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
/** `{files}` and `{tests}` become the quoted paths; a command without them runs as written. */
export function buildCommand(template, files, tests = []) {
    return template.replace('{files}', files.map(shellQuote).join(' ')).replace('{tests}', tests.map(shellQuote).join(' '));
}
export function runTests(command, cwd) {
    const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}
/** Repo-relative files made relative to the package root, as test runners expect them. */
export function relativeToPackage(repoRoot, packageRoot, files) {
    const absoluteRoot = path.resolve(repoRoot, packageRoot);
    return files.map((file) => path.relative(absoluteRoot, path.resolve(repoRoot, file)));
}
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Matches the module's file name as a whole word: an import (`'../module.js'`) as well as a
 * reference through a generated API (`internal.tasks.module`). A common name only adds tests.
 */
function referencePattern(file) {
    const stem = escapeRegExp(path.basename(file).replace(/\.[cm]?[jt]sx?$/, ''));
    return new RegExp(`(?:^|[^A-Za-z0-9_$])${stem}(?:[^A-Za-z0-9_$]|$)`);
}
const mentionsAny = (text, patterns) => text !== undefined && patterns.some((pattern) => pattern.test(text));
/**
 * Test files that reach a changed module by name, directly or through `depth - 1` modules that
 * mention it. A cheap stand-in for the import graph when the runner's own one reaches every test
 * (a generated API that imports everything); generated files are skipped as links for that reason.
 */
export function testsImporting(search) {
    const isTest = picomatch(search.testGlobs, { dot: true });
    const tests = search.packageFiles.filter(isTest);
    const sources = search.packageFiles.filter((file) => !isTest(file) && search.isLinkingSource(file));
    const found = new Set();
    let modules = search.changed;
    for (let level = 0; level < (search.depth ?? 2) && modules.length > 0; level++) {
        const patterns = modules.map(referencePattern);
        for (const test of tests)
            if (mentionsAny(search.read(test), patterns))
                found.add(test);
        const seen = new Set(modules);
        modules = sources.filter((file) => !seen.has(file) && mentionsAny(search.read(file), patterns));
    }
    return tests.filter((test) => found.has(test));
}
