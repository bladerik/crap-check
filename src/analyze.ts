/**
 * Turns a change (changed lines, source, coverage, base) into verdicts. No git, file system or
 * processes here: the caller passes everything in, so this is easy to test.
 */
import path from 'node:path';
import type { Baseline } from './baseline.js';
import { judge, touchedFunctions, type BaseFunction, type Measured, type Verdict } from './compare.js';
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

function checkFile(input: CheckInput, change: FileChange, warnings: string[]): Verdict[] {
	const text = input.readCurrent(change.file);
	if (text === undefined) return [];
	const lines = input.coverage.get(path.resolve(input.repoRoot, change.file));
	if (!looksSourceMapped(text, lines)) {
		warnings.push(`${change.file}: coverage lines do not match the source (no source maps?); coverage may be wrong`);
	}
	const measured = measureFile(input.repoRoot, change.file, text, input.coverage);
	const base = baseFunctionsFor(input, change.previousFile ?? change.file);
	return touchedFunctions(measured, change.addedLines).map((fn) => judge(fn, base, input.config.threshold));
}

const severity = { fail: 0, warn: 1, ok: 2 } as const;

export function checkChange(input: CheckInput): CheckResult {
	const isSource = sourceFileFilter(input.config);
	const warnings: string[] = [];
	const verdicts = input.changes
		.filter((change) => isSource(change.file) && packageFor(input.config, change.file))
		.flatMap((change) => checkFile(input, change, warnings))
		.sort((a, b) => severity[a.status] - severity[b.status] || b.crap - a.crap);
	const changedFiles = input.changes.map((change) => change.file);
	return {
		verdicts,
		warnings,
		changedFiles,
		tier: suggestTier(changedFiles.filter(reviewableFileFilter(input.config)), input.config.reviewTiers),
		failed: verdicts.some((verdict) => verdict.status === 'fail')
	};
}
