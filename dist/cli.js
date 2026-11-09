#!/usr/bin/env node
/**
 * crap-check [check]   CRAP of the functions changed against the base branch; exit 1 on a failure.
 * crap-check --all     The worst functions of the whole project.
 * crap-check baseline  Store the CRAP of every function at HEAD, for later checks against it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { checkChange, measureFile } from './analyze.js';
import { baselinePath, readBaseline, writeBaseline } from './baseline.js';
import { needsCoverage } from './compare.js';
import { CONFIG_FILE, loadConfig, packageFor } from './config.js';
import { collectCoverage } from './collect.js';
import { changedFiles, fileAt, gitCommonDir, headSha, mergeBase, repoRoot, trackedFiles as gitTrackedFiles, uncommittedFiles } from './git.js';
import { jsonReport, markdownReport, topReport } from './report.js';
import { sourceFileFilter } from './tiers.js';
class UsageError extends Error {
}
const USAGE = `Usage: crap-check [check] [options]   judge the functions the change touches (exit 0 ok, 1 failed, 2 no verdict)
       crap-check --all [--limit n]      the worst functions of the whole project
       crap-check baseline [--output f]  store the CRAP of every function at HEAD

Options:
  --base <ref>       compare with this branch (default: config "base", origin/main)
  --ref <commit>     judge this commit, not the working tree (pre-push hook)
  --no-run           read the coverage reports on disk instead of running tests
  --json             JSON instead of the Markdown table
  --baseline <file>  use this baseline file
  --config <file>    another config file (default crap.config.json)
  -h, --help         this help;  -v, --version  the version

Docs: https://github.com/bladerik/crap-check#readme`;
function version() {
    const manifest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
}
export function parseArgs(argv) {
    const options = { command: 'check', all: false, run: true, format: 'markdown', limit: 20 };
    const valueOf = (index) => {
        const value = argv[index + 1];
        if (value === undefined)
            throw new UsageError(`${argv[index]} needs a value`);
        return value;
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === 'check' || arg === 'baseline')
            options.command = arg;
        else if (arg === '--help' || arg === '-h')
            options.command = 'help';
        else if (arg === '--version' || arg === '-v')
            options.command = 'version';
        else if (arg === '--all')
            options.all = true;
        else if (arg === '--no-run')
            options.run = false;
        else if (arg === '--json')
            options.format = 'json';
        else if (arg === '--base')
            options.base = valueOf(i++);
        else if (arg === '--config')
            options.config = valueOf(i++);
        else if (arg === '--baseline')
            options.baselineFile = valueOf(i++);
        else if (arg === '--ref')
            options.ref = valueOf(i++);
        else if (arg === '--output')
            options.output = valueOf(i++);
        else if (arg === '--limit')
            options.limit = Number(valueOf(i++));
        else
            throw new UsageError(`Unknown argument: ${arg}`);
    }
    return options;
}
const readCurrent = (root) => (file) => {
    const absolute = path.resolve(root, file);
    return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : undefined;
};
const trackedFiles = (root) => () => gitTrackedFiles(root);
function trackedSourceFiles(root, config) {
    const isSource = sourceFileFilter(config);
    return trackedFiles(root)().filter((file) => isSource(file) && packageFor(config, file));
}
/** Every function of the project; packages that wrote no coverage report are left out and listed. */
function measureAll(root, config, run) {
    const files = trackedSourceFiles(root, config);
    const { coverage, warnings, unmeasured } = collectCoverage({ root, config, files, mode: 'testAll', run, trackedFiles: trackedFiles(root) });
    const read = readCurrent(root);
    const measured = files.filter((file) => !unmeasured.includes(packageFor(config, file)?.root ?? ''));
    const functions = measured.flatMap((file) => measureFile(root, file, read(file) ?? '', coverage));
    return { functions, warnings, unmeasured };
}
function runBaseline(root, config, options) {
    const { functions, warnings, unmeasured } = measureAll(root, config, options.run);
    if (unmeasured.length) {
        for (const warning of warnings)
            console.error(`Warning: ${warning}`);
        console.error(`crap-check: no baseline written: ${unmeasured.join(', ')} wrote no coverage report`);
        return 2;
    }
    const baseline = { sha: headSha(root), createdAt: new Date().toISOString(), files: {} };
    for (const fn of functions) {
        (baseline.files[fn.file] ??= []).push({ name: fn.name, bodyHash: fn.bodyHash, complexity: fn.complexity, crap: fn.crap });
    }
    const target = options.output ?? baselinePath(gitCommonDir(root), baseline.sha);
    writeBaseline(target, baseline);
    for (const warning of warnings)
        console.error(`Warning: ${warning}`);
    console.log(`Baseline for ${baseline.sha.slice(0, 12)}: ${functions.length} functions -> ${target}`);
    return 0;
}
function runAll(root, config, options) {
    const { functions, warnings, unmeasured } = measureAll(root, config, options.run);
    console.log(topReport(functions, options.limit));
    if (unmeasured.length)
        console.log(`\nNot measured (no coverage report, left out): ${unmeasured.join(', ')}`);
    for (const warning of warnings)
        console.error(`Warning: ${warning}`);
    return unmeasured.length ? 2 : 0;
}
/**
 * With `--ref`, sources and config come from that commit but tests run on the working tree.
 * Uncommitted code in the packages being checked (a test not yet committed, for example) would lend
 * the commit coverage it does not have, so refuse.
 */
function assertCommitted(root, config, options, sources) {
    const ref = options.ref;
    if (!ref)
        return;
    const roots = [...new Set(sources.flatMap((file) => packageFor(config, file)?.root ?? []))];
    // Sources, tests and fixtures all shape coverage; notes, docs and the config (read from the ref) cannot.
    const isDoc = picomatch(['**/*.{md,mdx,txt}'], { dot: true });
    const configFile = path.relative(root, path.resolve(root, options.config ?? CONFIG_FILE));
    const isReport = coverageOutput(config);
    const dirty = uncommittedFiles(root, ref, roots).filter((file) => !isDoc(file) && file !== configFile && !isReport(file));
    if (dirty.length === 0)
        return;
    const listed = dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? ', …' : '');
    throw new Error(`uncommitted changes in ${roots.join(', ')} (${listed}): commit or stash them first; the tests run on the working tree`);
}
/**
 * The coverage reports the check itself writes (and, when a report sits in its own folder, that
 * folder): left over from the last run, they must not stop the next one. Paths are repo-relative.
 */
export function coverageOutput(config) {
    const outputs = config.packages.map((pkg) => {
        const report = path.posix.normalize(path.posix.join(pkg.root, pkg.coverage));
        const folder = path.posix.dirname(report);
        return { report, folder: folder === path.posix.normalize(pkg.root) ? undefined : `${folder}/` };
    });
    return (file) => outputs.some(({ report, folder }) => file === report || (folder !== undefined && file.startsWith(folder)));
}
const filesOf = (verdicts) => [...new Set(verdicts.map((verdict) => verdict.file))];
/** Files with a verdict that coverage could still change. */
const pendingFiles = (result, threshold) => filesOf(result.verdicts.filter((verdict) => needsCoverage(verdict, threshold)));
/** The coverage of these repo-relative files only, as one run measured them; absent files stay absent. */
function coverageOfFiles(root, from, files, into) {
    for (const file of files) {
        const lines = from.get(path.resolve(root, file));
        if (lines)
            into.set(path.resolve(root, file), lines);
    }
}
/**
 * Runs tests only where coverage could change a verdict: first the package's `testFirst` (a narrow,
 * quick run) where it has one, then `test` for the files where something still fails. Each file is
 * judged by the coverage of the run that decided it: a file the first run settled keeps that run's
 * coverage, and only when its own package wrote a report (another package's tests reaching it do
 * not settle it); a file sent on gets the full run's coverage or, missing from it, none.
 */
function measureLazily(root, config, input, pending) {
    const full = new Set();
    const partial = new Set();
    const coverageOf = (file) => (full.has(file) ? 'full' : partial.has(file) ? 'partial' : 'none');
    const collect = (files, mode) => collectCoverage({ root, config, files, mode, run: true, trackedFiles: trackedFiles(root) });
    const first = pending.filter((file) => packageFor(config, file)?.testFirst);
    const narrow = first.length ? collect(first, 'testFirst') : { coverage: new Map(), warnings: [], reported: [] };
    const failing = new Set(pendingFiles(checkChange({ ...input, coverage: narrow.coverage }), config.threshold));
    const reported = new Set(narrow.reported);
    for (const file of first)
        if (!failing.has(file) && reported.has(packageFor(config, file).root))
            partial.add(file);
    const coverage = new Map();
    coverageOfFiles(root, narrow.coverage, partial, coverage);
    const rest = pending.filter((file) => !partial.has(file));
    if (rest.length === 0)
        return { coverage, warnings: narrow.warnings, coverageOf };
    const wide = collect(rest, 'test');
    for (const file of rest)
        full.add(file);
    coverageOfFiles(root, wide.coverage, rest, coverage);
    return { coverage, warnings: [...narrow.warnings, ...wide.warnings], unmeasured: wide.unmeasured, coverageOf };
}
function runCheck(root, config, options) {
    const baseSha = mergeBase(root, options.base ?? config.base, options.ref);
    const changes = changedFiles(root, baseSha, options.ref);
    const read = options.ref ? (file) => fileAt(root, options.ref, file) : readCurrent(root);
    const baseline = readBaseline(options.baselineFile ?? baselinePath(gitCommonDir(root), baseSha));
    const input = { repoRoot: root, config, changes, readCurrent: read, readBase: (file) => fileAt(root, baseSha, file), baseline };
    // Judged at 0% coverage first: tests run only where coverage could change a verdict, so a copy
    // edit, a simple function or an old one that did not get more complex costs no test run.
    const atZero = checkChange({ ...input, coverage: new Map() });
    assertCommitted(root, config, options, filesOf(atZero.verdicts));
    const pending = pendingFiles(atZero, config.threshold);
    // --no-run reads the reports on disk for every touched file: they cost nothing.
    const collected = !options.run
        ? collectCoverage({ root, config, files: filesOf(atZero.verdicts), mode: 'test', run: false, trackedFiles: trackedFiles(root) })
        : pending.length
            ? measureLazily(root, config, input, pending)
            : { coverage: new Map(), warnings: [], coverageOf: () => 'none' };
    const result = checkChange({ ...input, ...collected });
    result.warnings.unshift(...collected.warnings);
    console.log(options.format === 'json' ? jsonReport(result) : markdownReport(result, config.threshold));
    if (result.failed)
        return 1;
    return result.incomplete ? 2 : 0;
}
/** A programming error inside crap-check, not a usage, git or config problem it reports itself. */
const isInternal = (error) => error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || !(error instanceof Error);
export function main(argv) {
    try {
        const options = parseArgs(argv);
        if (options.command === 'help' || options.command === 'version') {
            console.log(options.command === 'help' ? USAGE : version());
            return 0;
        }
        const root = repoRoot(process.cwd());
        const ref = options.ref;
        const config = loadConfig(root, options.config, ref ? (file) => fileAt(root, ref, file) : undefined);
        if (options.command === 'baseline')
            return runBaseline(root, config, options);
        return options.all ? runAll(root, config, options) : runCheck(root, config, options);
    }
    catch (error) {
        console.error(`crap-check: ${error instanceof Error ? error.message : String(error)}`);
        if (isInternal(error)) {
            console.error(error instanceof Error ? error.stack : '');
            console.error('This is a bug in crap-check. Please report it with a small reproduction: https://github.com/bladerik/crap-check/issues');
        }
        return 2;
    }
}
const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly)
    process.exitCode = main(process.argv.slice(2));
