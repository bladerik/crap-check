#!/usr/bin/env node
/**
 * crap-check [check]   CRAP of the functions changed against the base branch; exit 1 on a failure.
 * crap-check --all     The worst functions of the whole project.
 * crap-check baseline  Store the CRAP of every function at HEAD, for later checks against it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkChange, measureFile } from './analyze.js';
import { baselinePath, readBaseline, writeBaseline } from './baseline.js';
import { loadConfig, packageFor } from './config.js';
import { collectCoverage } from './collect.js';
import { changedFiles, fileAt, filesDifferingFrom, gitCommonDir, headSha, mergeBase, repoRoot, trackedFiles as gitTrackedFiles } from './git.js';
import { jsonReport, markdownReport, topReport } from './report.js';
import { sourceFileFilter } from './tiers.js';
class UsageError extends Error {
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
function measureAll(root, config, run) {
    const files = trackedSourceFiles(root, config);
    const { coverage, warnings } = collectCoverage({ root, config, files, mode: 'testAll', run, trackedFiles: trackedFiles(root) });
    const read = readCurrent(root);
    const functions = files.flatMap((file) => measureFile(root, file, read(file) ?? '', coverage));
    return { functions, warnings };
}
function runBaseline(root, config, options) {
    const { functions, warnings } = measureAll(root, config, options.run);
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
    const { functions, warnings } = measureAll(root, config, options.run);
    console.log(topReport(functions, options.limit));
    for (const warning of warnings)
        console.error(`Warning: ${warning}`);
    return 0;
}
/** With `--ref`, sources come from that commit; tests still run on the working tree, so say when they differ. */
function refWarnings(root, ref, sources) {
    if (!ref)
        return [];
    const differing = filesDifferingFrom(root, ref, sources);
    return differing.length
        ? [`the working tree differs from ${ref.slice(0, 12)} in ${differing.join(', ')}; coverage comes from the working tree`]
        : [];
}
function runCheck(root, config, options) {
    const baseSha = mergeBase(root, options.base ?? config.base, options.ref);
    const changes = changedFiles(root, baseSha, options.ref);
    const isSource = sourceFileFilter(config);
    const read = options.ref ? (file) => fileAt(root, options.ref, file) : readCurrent(root);
    const sources = changes.map((change) => change.file).filter((file) => isSource(file) && read(file) !== undefined);
    const collected = sources.length
        ? collectCoverage({ root, config, files: sources, mode: 'test', run: options.run, trackedFiles: trackedFiles(root) })
        : { coverage: new Map(), warnings: [] };
    const { coverage } = collected;
    const warnings = [...refWarnings(root, options.ref, sources), ...collected.warnings];
    const baseline = readBaseline(options.baselineFile ?? baselinePath(gitCommonDir(root), baseSha));
    const result = checkChange({ repoRoot: root, config, changes, coverage, readCurrent: read, readBase: (file) => fileAt(root, baseSha, file), baseline });
    result.warnings.unshift(...warnings);
    console.log(options.format === 'json' ? jsonReport(result) : markdownReport(result, config.threshold));
    return result.failed ? 1 : 0;
}
export function main(argv) {
    try {
        const options = parseArgs(argv);
        const root = repoRoot(process.cwd());
        const config = loadConfig(root, options.config);
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
