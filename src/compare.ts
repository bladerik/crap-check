/**
 * The verdict for each function a change touches. New functions must stay at or under the
 * threshold. A changed function may sit above it as long as it did not get more complex, so a
 * one-line fix in old code does not force a rewrite. (Complexity, not CRAP: the check measures
 * coverage with the related tests only, a baseline with the whole suite, so their CRAP differs.)
 */
import type { FunctionInfo } from './functions.js';

export type Measured = FunctionInfo & { file: string; coverage: number; crap: number };

/** What base knew about a function: its complexity, and its CRAP when a baseline exists. */
export type BaseFunction = { name: string; bodyHash: string; complexity: number; crap?: number };

/** Base functions of every file the change touches, with their file, and what still exists at head. */
export type BaseContext = {
	/** Base functions of the same file (its previous path when renamed). */
	sameFile: BaseFunction[];
	/** Base functions of all changed, renamed and deleted files. */
	pool: Array<BaseFunction & { file: string }>;
	/** `file::name` of every function at head in the changed files. */
	atHead: Set<string>;
};

export type Kind = 'new' | 'changed' | 'moved';
export type Status = 'ok' | 'warn' | 'fail';

export type Verdict = Measured & {
	kind: Kind;
	status: Status;
	base?: BaseFunction;
	reason?: string;
};

export const headKey = (file: string, name: string) => `${file}::${name}`;

const touches = (fn: FunctionInfo, lines: Set<number>) => {
	for (const line of lines) if (line >= fn.startLine && line <= fn.endLine) return true;
	return false;
};

/** Functions containing an added or modified line. Outer functions count too: their range changed. */
export function touchedFunctions<T extends FunctionInfo>(functions: T[], addedLines: Set<number>): T[] {
	return functions.filter((fn) => touches(fn, addedLines));
}

/**
 * Same name in the same file: changed. Otherwise an identical body whose original is gone at head
 * (renamed, or moved to another file): moved. A copy of a function that still exists is new.
 */
export function matchBase(fn: FunctionInfo, base: BaseContext): { kind: Kind; base?: BaseFunction } {
	const byName = base.sameFile.find((candidate) => candidate.name === fn.name);
	if (byName) return { kind: 'changed', base: byName };
	const moved = base.pool.find(
		(candidate) => candidate.bodyHash === fn.bodyHash && !base.atHead.has(headKey(candidate.file, candidate.name))
	);
	return moved ? { kind: 'moved', base: moved } : { kind: 'new' };
}

function judgeExisting(fn: Measured, base: BaseFunction, threshold: number): { status: Status; reason?: string } {
	if (fn.crap <= threshold) return { status: 'ok' };
	return fn.complexity > base.complexity
		? { status: 'fail', reason: `complexity rose from ${base.complexity} and CRAP is over ${threshold}` }
		: { status: 'warn', reason: `over ${threshold}, not more complex than before` };
}

export function judge(fn: Measured, base: BaseContext, threshold: number): Verdict {
	const match = matchBase(fn, base);
	if (match.kind === 'new' || !match.base) {
		return fn.crap <= threshold
			? { ...fn, kind: 'new', status: 'ok' }
			: { ...fn, kind: 'new', status: 'fail', reason: `new function over ${threshold}` };
	}
	return { ...fn, kind: match.kind, base: match.base, ...judgeExisting(fn, match.base, threshold) };
}
