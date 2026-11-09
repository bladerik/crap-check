/**
 * Turns a change (changed lines, source, coverage, base) into verdicts. No git, file system or
 * processes here: the caller passes everything in, so this is easy to test.
 */
import path from 'node:path';
import type { Baseline } from './baseline.js';
import { judge, needsCoverage, pairFunctions, touchedFunctions, withoutCoverage, type BaseFunction, type Match, type Measured, type Verdict } from './compare.js';
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
	/** Only shown: the base CRAP of changed functions. Verdicts come from the base source. */
	baseline?: Baseline;
	/** Package roots that wrote no coverage report: their functions get no verdict. */
	unmeasured?: string[];
	/**
	 * Which coverage a repo-relative file got when tests ran only where coverage could change a
	 * verdict: `full` from the package's `test` command, `partial` from `testFirst` (enough to pass
	 * what it had to), `none` (no tests ran). Absent: every file is fully measured.
	 */
	coverageOf?: (file: string) => 'full' | 'partial' | 'none';
};

export type CheckResult = {
	verdicts: Verdict[];
	warnings: string[];
	changedFiles: string[];
	tier?: ReviewTier;
	failed: boolean;
	/** Some touched functions could not be measured. */
	incomplete: boolean;
};

/** Every function of one file with its coverage and CRAP. */
export function measureFile(repoRoot: string, file: string, text: string, coverage: LineCoverage): Measured[] {
	const lines = coverage.get(path.resolve(repoRoot, file));
	return findFunctions(file, text).map((fn) => {
		const covered = functionCoverage(fn, lines);
		return { ...fn, file, coverage: covered, crap: round1(crapScore(fn.complexity, covered)) };
	});
}

/** Base functions of a file, parsed from the base source; the baseline adds their CRAP by name. */
export function baseFunctionsFor(input: CheckInput, baseFile: string): BaseFunction[] {
	const text = input.readBase(baseFile);
	if (text === undefined) return [];
	const crapByName = new Map((input.baseline?.files[baseFile] ?? []).map((fn) => [fn.name, fn.crap]));
	return findFunctions(baseFile, text).map(({ name, bodyHash, bodyText, complexity }) => ({
		name,
		bodyHash,
		bodyText,
		complexity,
		crap: crapByName.get(name)
	}));
}

type FileView = { change: FileChange; head: Measured[]; base: BaseFunction[]; pairs: Map<number, number> };

/** Head functions of a changed file (none when deleted), its base functions and how they pair. */
function viewFile(input: CheckInput, change: FileChange, warnings: string[]): FileView {
	const base = baseFunctionsFor(input, change.previousFile ?? change.file);
	const text = change.deleted ? undefined : input.readCurrent(change.file);
	if (text === undefined) return { change, head: [], base, pairs: new Map() };
	const lines = input.coverage.get(path.resolve(input.repoRoot, change.file));
	if (!looksSourceMapped(text, lines)) {
		warnings.push(`${change.file}: coverage lines do not match the source (no source maps?); coverage may be wrong`);
	}
	const head = measureFile(input.repoRoot, change.file, text, input.coverage);
	return { change, head, base, pairs: pairFunctions(head, base) };
}

/** Base functions no head function paired with: removed, or moved elsewhere. */
function unpairedBase(views: FileView[]): BaseFunction[] {
	return views.flatMap((view) => {
		const paired = new Set(view.pairs.values());
		return view.base.filter((_, index) => !paired.has(index));
	});
}

/**
 * Unpaired head functions with the identical body of an unpaired base function moved there. Each
 * base function moves once, to a function of the same name first: a second copy is new.
 */
function assignMoves(views: FileView[], leftovers: BaseFunction[]): Map<Measured, BaseFunction> {
	const unpaired = views.flatMap((view) => view.head.filter((_, index) => !view.pairs.has(index)));
	const moves = new Map<Measured, BaseFunction>();
	const taken = new Set<BaseFunction>();
	for (const sameNameOnly of [true, false]) {
		for (const fn of unpaired) {
			if (moves.has(fn)) continue;
			const from = leftovers.find(
				(base) => !taken.has(base) && base.bodyHash === fn.bodyHash && (!sameNameOnly || base.name === fn.name)
			);
			if (!from) continue;
			moves.set(fn, from);
			taken.add(from);
		}
	}
	return moves;
}

/** Paired with its base version: changed. Took over a removed function's body: moved. Else new. */
function matchFor(view: FileView, fn: Measured, moves: Map<Measured, BaseFunction>): Match {
	const paired = view.pairs.get(view.head.indexOf(fn));
	if (paired !== undefined) return { kind: 'changed', base: view.base[paired] };
	const moved = moves.get(fn);
	return moved ? { kind: 'moved', base: moved } : { kind: 'new' };
}

const severity = { fail: 0, unmeasured: 1, warn: 2, ok: 3 } as const;

/**
 * A function in a package whose run wrote no coverage report. Only a verdict coverage could change
 * becomes "not measured" (0% would be a guess); one that holds at any coverage stands, without
 * tests. Files another run decided keep its verdict.
 */
function unmeasuredIn(input: CheckInput): (verdict: Verdict) => Verdict {
	const roots = new Set(input.unmeasured ?? []);
	const fromThatRun = (file: string) => (input.coverageOf?.(file) ?? 'full') === 'full';
	return (verdict) => {
		if (!roots.has(packageFor(input.config, verdict.file)?.root ?? '') || !fromThatRun(verdict.file)) return verdict;
		if (needsCoverage(verdict, input.config.threshold)) return { ...verdict, status: 'unmeasured', reason: 'no coverage report' };
		// Another package's tests ran it: a measured pass.
		return verdict.status === 'ok' && verdict.coverage > 0 ? verdict : withoutCoverage(verdict);
	};
}

/**
 * Verdicts from less than full coverage: without any, the verdict holds at any coverage; with the
 * narrow first run, a pass is proven, while a let through needs the full run, so it is not claimed.
 */
function lazyIn(input: CheckInput): (verdict: Verdict) => Verdict {
	return (verdict) => {
		const how = input.coverageOf?.(verdict.file) ?? 'full';
		if (how === 'full' || verdict.status === 'unmeasured') return verdict;
		if (how === 'partial' && verdict.status !== 'warn') return verdict;
		return withoutCoverage(verdict);
	};
}

/** Every path the change touches, old paths of renames and deletions included. */
const touchedPaths = (changes: FileChange[]) =>
	[...new Set(changes.flatMap((change) => [change.file, change.previousFile].filter((file): file is string => Boolean(file))))];

export function checkChange(input: CheckInput): CheckResult {
	const isSource = sourceFileFilter(input.config);
	const warnings: string[] = [];
	const scored = input.changes.filter((change) => isSource(change.file) && packageFor(input.config, change.file));
	const views = scored.map((change) => viewFile(input, change, warnings));
	const moves = assignMoves(views, unpairedBase(views));
	const verdicts = views
		.flatMap((view) =>
			touchedFunctions(view.head, view.change.addedLines).map((fn) => judge(fn, matchFor(view, fn, moves), input.config.threshold))
		)
		.map(unmeasuredIn(input))
		.map(lazyIn(input))
		.sort((a, b) => severity[a.status] - severity[b.status] || b.crap - a.crap);
	const changedFiles = touchedPaths(input.changes);
	return {
		verdicts,
		warnings,
		changedFiles,
		tier: suggestTier(changedFiles.filter(reviewableFileFilter(input.config)), input.config.reviewTiers),
		failed: verdicts.some((verdict) => verdict.status === 'fail'),
		incomplete: verdicts.some((verdict) => verdict.status === 'unmeasured')
	};
}
