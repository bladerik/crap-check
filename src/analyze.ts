/**
 * Turns a change (changed lines, source, coverage, base) into verdicts. No git, file system or
 * processes here: the caller passes everything in, so this is easy to test.
 */
import path from 'node:path';
import type { Baseline } from './baseline.js';
import { headKey, judge, touchedFunctions, type BaseFunction, type Measured, type Verdict } from './compare.js';
import { packageFor, type Config, type ReviewTier } from './config.js';
import { functionCoverage, looksSourceMapped, type LineCoverage } from './coverage.js';
import { crapScore, round1 } from './crap.js';
import { findFunctions } from './functions.js';
import type { FileChange } from './git.js';
import { reviewableFileFilter, sourceFileFilter, suggestTier } from './tiers.js';

export type CheckInput = {
	repoRoot: string;
	config: Config;
	changes: FileChange[];
	coverage: LineCoverage;
	/** Current text of a repo-relative file, undefined when deleted. */
	readCurrent: (file: string) => string | undefined;
	/** Text of a repo-relative file on base, undefined when it did not exist. */
	readBase: (file: string) => string | undefined;
	baseline?: Baseline;
};

export type CheckResult = {
	verdicts: Verdict[];
	warnings: string[];
	changedFiles: string[];
	tier?: ReviewTier;
	failed: boolean;
};

/** Every function of one file with its coverage and CRAP. */
export function measureFile(repoRoot: string, file: string, text: string, coverage: LineCoverage): Measured[] {
	const lines = coverage.get(path.resolve(repoRoot, file));
	return findFunctions(file, text).map((fn) => {
		const covered = functionCoverage(fn, lines);
		return { ...fn, file, coverage: covered, crap: round1(crapScore(fn.complexity, covered)) };
	});
}

/** Base functions of a file: from the baseline (with CRAP) or parsed from the base source (complexity only). */
export function baseFunctionsFor(input: CheckInput, baseFile: string): BaseFunction[] {
	const fromBaseline = input.baseline?.files[baseFile];
	if (fromBaseline) return fromBaseline;
	const text = input.readBase(baseFile);
	if (text === undefined) return [];
	return findFunctions(baseFile, text).map(({ name, bodyHash, complexity }) => ({ name, bodyHash, complexity }));
}

type MeasuredChange = { change: FileChange; measured: Measured[] };

/** Measures a changed file at head, warning when its coverage is not mapped onto the source. */
function measureChange(input: CheckInput, change: FileChange, warnings: string[]): MeasuredChange | undefined {
	const text = change.deleted ? undefined : input.readCurrent(change.file);
	if (text === undefined) return undefined;
	const lines = input.coverage.get(path.resolve(input.repoRoot, change.file));
	if (!looksSourceMapped(text, lines)) {
		warnings.push(`${change.file}: coverage lines do not match the source (no source maps?); coverage may be wrong`);
	}
	return { change, measured: measureFile(input.repoRoot, change.file, text, input.coverage) };
}

/** Base functions of every changed, renamed and deleted file, and the functions that exist at head. */
function baseContext(input: CheckInput, scored: FileChange[], measured: MeasuredChange[]) {
	const pool = scored.flatMap((change) => {
		const baseFile = change.previousFile ?? change.file;
		return baseFunctionsFor(input, baseFile).map((fn) => ({ ...fn, file: baseFile }));
	});
	const atHead = new Set(measured.flatMap(({ change, measured: fns }) => fns.map((fn) => headKey(change.file, fn.name))));
	return { pool, atHead };
}

const severity = { fail: 0, warn: 1, ok: 2 } as const;

/** Every path the change touches, old paths of renames and deletions included. */
const touchedPaths = (changes: FileChange[]) =>
	[...new Set(changes.flatMap((change) => [change.file, change.previousFile].filter((file): file is string => Boolean(file))))];

export function checkChange(input: CheckInput): CheckResult {
	const isSource = sourceFileFilter(input.config);
	const warnings: string[] = [];
	const scored = input.changes.filter((change) => isSource(change.file) && packageFor(input.config, change.file));
	const measured = scored.flatMap((change) => measureChange(input, change, warnings) ?? []);
	const { pool, atHead } = baseContext(input, scored, measured);
	const verdicts = measured
		.flatMap(({ change, measured: fns }) => {
			const sameFile = pool.filter((fn) => fn.file === (change.previousFile ?? change.file));
			return touchedFunctions(fns, change.addedLines).map((fn) => judge(fn, { sameFile, pool, atHead }, input.config.threshold));
		})
		.sort((a, b) => severity[a.status] - severity[b.status] || b.crap - a.crap);
	const changedFiles = touchedPaths(input.changes);
	return {
		verdicts,
		warnings,
		changedFiles,
		tier: suggestTier(changedFiles.filter(reviewableFileFilter(input.config)), input.config.reviewTiers),
		failed: verdicts.some((verdict) => verdict.status === 'fail')
	};
}
