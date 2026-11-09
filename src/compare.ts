/**
 * The verdict for each function a change touches. New functions must stay at or under the
 * threshold. A changed function may sit above it as long as it did not get more complex, so a
 * one-line fix in old code does not force a rewrite; such functions are reported as "let through".
 * (Complexity, not CRAP, decides: the check measures coverage with the related tests only, a
 * baseline with the whole suite, so their CRAP values are not comparable.)
 */
import type { FunctionInfo } from './functions.js';

export type Measured = FunctionInfo & { file: string; coverage: number; crap: number };

/** A function on base: parsed from the base source, with its CRAP when a baseline knows it. */
export type BaseFunction = { name: string; bodyHash: string; complexity: number; bodyText?: string; crap?: number };

export type Kind = 'new' | 'changed' | 'moved';
/** warn: let through. unmeasured: its package wrote no coverage report, so no verdict. */
export type Status = 'ok' | 'warn' | 'fail' | 'unmeasured';
export type Match = { kind: Kind; base?: BaseFunction };

export type Verdict = Measured & {
	kind: Kind;
	status: Status;
	base?: BaseFunction;
	reason?: string;
};

const touches = (fn: FunctionInfo, lines: Set<number>) => {
	for (const line of lines) if (line >= fn.startLine && line <= fn.endLine) return true;
	return false;
};

/** Functions containing an added or modified line. Outer functions count too: their range changed. */
export function touchedFunctions<T extends FunctionInfo>(functions: T[], addedLines: Set<number>): T[] {
	return functions.filter((fn) => touches(fn, addedLines));
}

/** The name without its `#2` repeat label. */
export const stem = (name: string) => name.replace(/#\d+$/, '');

const tokens = (text: string) => new Set(text.split(/[^A-Za-z0-9_$]+/).filter(Boolean));

/** Share of distinct identifiers two bodies have in common (Jaccard), 0..1. */
export function similarity(a: string, b: string): number {
	const left = tokens(a);
	const right = tokens(b);
	if (left.size === 0 && right.size === 0) return 1;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	return shared / (left.size + right.size - shared);
}

const countBy = (names: string[]) => {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(stem(name), (counts.get(stem(name)) ?? 0) + 1);
	return counts;
};

/**
 * What a callback is a callback of: the name without its other call arguments and repeat label
 * (`C/useEffect(<callback>, [id])#2` -> `C/useEffect`). Editing a hook's deps or a route's path
 * changes the name, not the function. Other names stay as they are.
 */
export const calleeKey = (name: string) => stem(name).replace(/\((?:[^()]|\([^()]*\))*\)$/, '');

/**
 * Pairs the head functions of one file with their base versions (head index -> base index). Each
 * stage only sees what earlier stages left:
 * 1. an identical body under the same name stem;
 * 2. the same name, when that stem occurs equally often on both sides (nothing inserted or removed);
 * 3. an identical body under the same callee (a hook's deps or a route's path changed);
 * 4. the most similar body under the same stem, then under the same callee (at least half of the
 *    identifiers shared, best pairs first, so a new function inserted above cannot take the place
 *    of an edited one).
 * Repeat labels (`#2`) shift when a same-named callback is inserted, so they never decide alone.
 */
export function pairFunctions(head: FunctionInfo[], base: BaseFunction[]): Map<number, number> {
	const pairs = new Map<number, number>();
	const used = new Set<number>();
	const pair = (h: number, b: number) => {
		pairs.set(h, b);
		used.add(b);
	};
	const key = { stem, callee: calleeKey };
	const open = (h: number, by: keyof typeof key) =>
		base.map((_, b) => b).filter((b) => !used.has(b) && key[by](base[b].name) === key[by](head[h].name));
	const byBody = (by: keyof typeof key) =>
		head.forEach((fn, h) => {
			if (pairs.has(h)) return;
			const same = open(h, by).find((b) => base[b].bodyHash === fn.bodyHash);
			if (same !== undefined) pair(h, same);
		});
	const bySimilarity = (by: keyof typeof key) => {
		const candidates = head
			.flatMap((fn, h) => (pairs.has(h) ? [] : open(h, by).map((b) => ({ h, b, score: similarity(fn.bodyText, base[b].bodyText ?? '') }))))
			.filter((candidate) => candidate.score >= 0.5)
			.sort((x, y) => y.score - x.score);
		for (const { h, b } of candidates) if (!pairs.has(h) && !used.has(b)) pair(h, b);
	};
	byBody('stem');
	const headCounts = countBy(head.map((fn) => fn.name));
	const baseCounts = countBy(base.map((fn) => fn.name));
	head.forEach((fn, h) => {
		if (pairs.has(h) || headCounts.get(stem(fn.name)) !== baseCounts.get(stem(fn.name))) return;
		const byName = open(h, 'stem').find((b) => base[b].name === fn.name);
		if (byName !== undefined) pair(h, byName);
	});
	byBody('callee');
	bySimilarity('stem');
	bySimilarity('callee');
	return pairs;
}

/** Why an old function over the threshold was let through, with what the baseline knew. */
function letThroughReason(fn: Measured, base: BaseFunction, threshold: number): string {
	if (base.crap !== undefined && base.crap <= threshold) {
		return `was CRAP ${base.crap.toFixed(1)} in the baseline: it lost coverage, or the related tests miss it`;
	}
	if (base.crap !== undefined && fn.crap > base.crap + 0.05) {
		return `not more complex; CRAP rose from ${base.crap.toFixed(1)} (lower coverage than the full-suite baseline)`;
	}
	return `over ${threshold} before too, not more complex`;
}

function judgeExisting(fn: Measured, base: BaseFunction, threshold: number): { status: Status; reason?: string } {
	if (fn.crap <= threshold) return { status: 'ok' };
	if (fn.complexity <= base.complexity) return { status: 'warn', reason: letThroughReason(fn, base, threshold) };
	// Full coverage leaves CRAP equal to complexity, so above the threshold no test can make it pass.
	const why =
		fn.complexity > threshold
			? `complexity rose from ${base.complexity}; above ${threshold} no test can pass it: split it, or keep it from growing`
			: `complexity rose from ${base.complexity} and CRAP is over ${threshold}`;
	return { status: 'fail', reason: why };
}

export function judge(fn: Measured, match: Match, threshold: number): Verdict {
	if (match.kind === 'new' || !match.base) {
		return fn.crap <= threshold
			? { ...fn, kind: 'new', status: 'ok' }
			: { ...fn, kind: 'new', status: 'fail', reason: `new function over ${threshold}` };
	}
	return { ...fn, kind: match.kind, base: match.base, ...judgeExisting(fn, match.base, threshold) };
}
