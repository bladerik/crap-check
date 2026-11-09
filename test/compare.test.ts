import { describe, expect, it } from 'vitest';
import { judge, matchBase, touchedFunctions, type Measured } from '../src/compare.js';
import { parseUnifiedDiff } from '../src/git.js';

const fn = (overrides: Partial<Measured> = {}): Measured => ({
	name: 'f',
	file: 'a.ts',
	startLine: 10,
	endLine: 20,
	complexity: 8,
	nestedRanges: [],
	bodyHash: 'h1',
	coverage: 0,
	crap: 72,
	...overrides
});

describe('touched functions', () => {
	it('picks functions containing an added line, including the outer ones', () => {
		const outer = fn({ name: 'outer', startLine: 1, endLine: 30 });
		const inner = fn({ name: 'inner', startLine: 10, endLine: 12 });
		const other = fn({ name: 'other', startLine: 40, endLine: 50 });
		expect(touchedFunctions([outer, inner, other], new Set([11])).map((f) => f.name)).toEqual(['outer', 'inner']);
	});
});

describe('matching the base', () => {
	it('matches by name, then by an identical body (a move)', () => {
		const base = [{ name: 'old', bodyHash: 'h1', complexity: 8 }];
		expect(matchBase(fn({ name: 'old' }), base).kind).toBe('changed');
		expect(matchBase(fn({ name: 'renamed' }), base).kind).toBe('moved');
		expect(matchBase(fn({ name: 'fresh', bodyHash: 'h9' }), base).kind).toBe('new');
	});
});

describe('verdicts', () => {
	it('passes a new function at or under the threshold and fails one above it', () => {
		expect(judge(fn({ crap: 30 }), [], 30).status).toBe('ok');
		expect(judge(fn({ crap: 30.1 }), [], 30)).toMatchObject({ status: 'fail', kind: 'new' });
	});

	it('passes a changed function under the threshold whatever it was before', () => {
		expect(judge(fn({ crap: 12 }), [{ name: 'f', bodyHash: 'x', complexity: 2, crap: 2 }], 30).status).toBe('ok');
	});

	it('only warns about an old function over the threshold that did not get worse', () => {
		const verdict = judge(fn({ crap: 72 }), [{ name: 'f', bodyHash: 'x', complexity: 8, crap: 72 }], 30);
		expect(verdict).toMatchObject({ status: 'warn', kind: 'changed' });
	});

	it('fails an old function over the threshold whose CRAP rose', () => {
		const verdict = judge(fn({ crap: 90 }), [{ name: 'f', bodyHash: 'x', complexity: 8, crap: 72 }], 30);
		expect(verdict).toMatchObject({ status: 'fail', reason: 'CRAP rose from 72.0 and is over 30' });
	});

	it('without a baseline, compares complexity instead', () => {
		expect(judge(fn({ complexity: 9 }), [{ name: 'f', bodyHash: 'x', complexity: 8 }], 30).status).toBe('fail');
		expect(judge(fn({ complexity: 8 }), [{ name: 'f', bodyHash: 'x', complexity: 8 }], 30).status).toBe('warn');
	});
});

describe('diff parsing', () => {
	it('collects added lines per new file, handling renames and single-line hunks', () => {
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -3,0 +4,2 @@',
			'+one',
			'+two',
			'@@ -10 +12 @@',
			'diff --git a/old.ts b/new.ts',
			'similarity index 90%',
			'rename from old.ts',
			'rename to new.ts',
			'--- a/old.ts',
			'+++ b/new.ts',
			'@@ -1,0 +2 @@',
			'diff --git a/gone.ts b/gone.ts',
			'--- a/gone.ts',
			'+++ /dev/null',
			'@@ -1,3 +0,0 @@'
		].join('\n');
		expect(parseUnifiedDiff(diff)).toEqual([
			{ file: 'src/a.ts', addedLines: new Set([4, 5, 12]) },
			{ file: 'new.ts', previousFile: 'old.ts', addedLines: new Set([2]) }
		]);
	});
});
