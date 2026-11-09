#!/usr/bin/env node
/**
 * crap-check [check]   CRAP of the functions changed against the base branch; exit 1 on a failure.
 * crap-check --all     The worst functions of the whole project.
 * crap-check baseline  Store the CRAP of every function at HEAD, for later checks against it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkChange, measureFile } from './analyze.js';
import { baselinePath, readBaseline, writeBaseline, type Baseline } from './baseline.js';
import { loadConfig, packageFor, type Config } from './config.js';
import type { LineCoverage } from './coverage.js';
import { collectCoverage } from './collect.js';
import { changedFiles, fileAt, gitCommonDir, headSha, mergeBase, repoRoot } from './git.js';
import { jsonReport, markdownReport, topReport } from './report.js';
import { sourceFileFilter } from './tiers.js';
import { execFileSync } from 'node:child_process';

type Options = {
	command: 'check' | 'baseline';
	all: boolean;
	run: boolean;
	format: 'markdown' | 'json';
	base?: string;
	config?: string;
	baselineFile?: string;
	output?: string;
	limit: number;
};

class UsageError extends Error {}

export function parseArgs(argv: string[]): Options {
	const options: Options = { command: 'check', all: false, run: true, format: 'markdown', limit: 20 };
	const valueOf = (index: number) => {
		const value = argv[index + 1];
		if (value === undefined) throw new UsageError(`${argv[index]} needs a value`);
		return value;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === 'check' || arg === 'baseline') options.command = arg;
		else if (arg === '--all') options.all = true;
		else if (arg === '--no-run') options.run = false;
		else if (arg === '--json') options.format = 'json';
		else if (arg === '--base') options.base = valueOf(i++);
		else if (arg === '--config') options.config = valueOf(i++);
		else if (arg === '--baseline') options.baselineFile = valueOf(i++);
		else if (arg === '--output') options.output = valueOf(i++);
		else if (arg === '--limit') options.limit = Number(valueOf(i++));
		else throw new UsageError(`Unknown argument: ${arg}`);
	}
	return options;
}

const readCurrent = (root: string) => (file: string) => {
	const absolute = path.resolve(root, file);
	return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : undefined;
};

const trackedFiles = (root: string) => () =>
	execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
		.split('\n')
		.filter(Boolean);

function trackedSourceFiles(root: string, config: Config): string[] {
	const isSource = sourceFileFilter(config);
	return trackedFiles(root)().filter((file) => isSource(file) && packageFor(config, file));
}

function measureAll(root: string, config: Config, run: boolean) {
	const files = trackedSourceFiles(root, config);
	const { coverage, warnings } = collectCoverage({ root, config, files, mode: 'testAll', run, trackedFiles: trackedFiles(root) });
	const read = readCurrent(root);
	const functions = files.flatMap((file) => measureFile(root, file, read(file) ?? '', coverage));
	return { functions, warnings };
}

function runBaseline(root: string, config: Config, options: Options): number {
	const { functions, warnings } = measureAll(root, config, options.run);
	const baseline: Baseline = { sha: headSha(root), createdAt: new Date().toISOString(), files: {} };
	for (const fn of functions) {
		(baseline.files[fn.file] ??= []).push({ name: fn.name, bodyHash: fn.bodyHash, complexity: fn.complexity, crap: fn.crap });
	}
	const target = options.output ?? baselinePath(gitCommonDir(root), baseline.sha);
	writeBaseline(target, baseline);
	for (const warning of warnings) console.error(`Warning: ${warning}`);
	console.log(`Baseline for ${baseline.sha.slice(0, 12)}: ${functions.length} functions -> ${target}`);
	return 0;
}

function runAll(root: string, config: Config, options: Options): number {
	const { functions, warnings } = measureAll(root, config, options.run);
	console.log(topReport(functions, options.limit));
	for (const warning of warnings) console.error(`Warning: ${warning}`);
	return 0;
}

function runCheck(root: string, config: Config, options: Options): number {
	const baseSha = mergeBase(root, options.base ?? config.base);
	const changes = changedFiles(root, baseSha);
	const isSource = sourceFileFilter(config);
	const read = readCurrent(root);
	const sources = changes.map((change) => change.file).filter((file) => isSource(file) && read(file) !== undefined);
	const { coverage, warnings } = sources.length
		? collectCoverage({ root, config, files: sources, mode: 'test', run: options.run, trackedFiles: trackedFiles(root) })
		: { coverage: new Map() as LineCoverage, warnings: [] as string[] };
	const baseline = readBaseline(options.baselineFile ?? baselinePath(gitCommonDir(root), baseSha));
	const result = checkChange({ repoRoot: root, config, changes, coverage, readCurrent: read, readBase: (file) => fileAt(root, baseSha, file), baseline });
	result.warnings.unshift(...warnings);
	if (!baseline && result.verdicts.some((verdict) => verdict.kind !== 'new')) {
		result.warnings.push(`no baseline for ${baseSha.slice(0, 12)}: changed functions are compared by complexity only (run \`crap-check baseline\` on the base branch)`);
	}
	console.log(options.format === 'json' ? jsonReport(result) : markdownReport(result, config.threshold));
	return result.failed ? 1 : 0;
}

export function main(argv: string[]): number {
	try {
		const options = parseArgs(argv);
		const root = repoRoot(process.cwd());
		const config = loadConfig(root, options.config);
		if (options.command === 'baseline') return runBaseline(root, config, options);
		return options.all ? runAll(root, config, options) : runCheck(root, config, options);
	} catch (error) {
		console.error(`crap-check: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
