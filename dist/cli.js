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
function runCheck(root, config, options) {
    const baseSha = mergeBase(root, options.base ?? config.base, options.ref);
    const changes = changedFiles(root, baseSha, options.ref);
    const read = options.ref ? (file) => fileAt(root, options.ref, file) : readCurrent(root);
    const baseline = readBaseline(options.baselineFile ?? baselinePath(gitCommonDir(root), baseSha));
    const input = { repoRoot: root, config, changes, readCurrent: read, readBase: (file) => fileAt(root, baseSha, file), baseline };
    // Tests run only for files whose functions the change touches: a copy edit costs nothing.
    const touched = [...new Set(checkChange({ ...input, coverage: new Map() }).verdicts.map((verdict) => verdict.file))];
    assertCommitted(root, config, options, touched);
    const collected = touched.length
        ? collectCoverage({ root, config, files: touched, mode: 'test', run: options.run, trackedFiles: trackedFiles(root) })
        : { coverage: new Map(), warnings: [], unmeasured: [] };
    const result = checkChange({ ...input, coverage: collected.coverage, unmeasured: collected.unmeasured });
    result.warnings.unshift(...collected.warnings);
    console.log(options.format === 'json' ? jsonReport(result) : markdownReport(result, config.threshold));
    if (result.failed)
        return 1;
    return result.incomplete ? 2 : 0;
}
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
        return 2;
    }
}
const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly)
    process.exitCode = main(process.argv.slice(2));
