import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionCoverage, looksSourceMapped, mergeCoverage, parseIstanbulJson, parseLcov } from '../src/coverage.js';
import { crapScore } from '../src/crap.js';
import type { FunctionInfo } from '../src/functions.js';

const root = '/repo/pkg';

describe('reading coverage', () => {
	it('reads LCOV line hits, resolving paths against the package root', () => {
		const coverage = parseLcov('TN:\nSF:src/a.ts\nDA:1,3\nDA:2,0\nend_of_record\nSF:/abs/b.ts\nDA:5,1\nend_of_record\n', root);
		expect(coverage.get(path.resolve(root, 'src/a.ts'))).toEqual(new Map([[1, 3], [2, 0]]));
		expect(coverage.get('/abs/b.ts')).toEqual(new Map([[5, 1]]));
	});

	it('reads istanbul JSON statements by the line they start on', () => {
		const coverage = parseIstanbulJson(
			JSON.stringify({
				'/repo/pkg/src/a.ts': {
					path: '/repo/pkg/src/a.ts',
					statementMap: { '0': { start: { line: 2 } }, '1': { start: { line: 2 } }, '2': { start: { line: 4 } } },
					s: { '0': 0, '1': 2, '2': 0 }
				}
			}),
			root
		);
		expect(coverage.get('/repo/pkg/src/a.ts')).toEqual(new Map([[2, 2], [4, 0]]));
	});

	it('merges reports, keeping the highest hit count per line', () => {
		const merged = mergeCoverage(new Map([['/f', new Map([[1, 0]])]]), new Map([['/f', new Map([[1, 2], [3, 1]])]]));
		expect(merged.get('/f')).toEqual(new Map([[1, 2], [3, 1]]));
	});
});

describe('function coverage', () => {
	const fn: FunctionInfo = { name: 'f', startLine: 10, endLine: 20, complexity: 2, nestedRanges: [[14, 16]], bodyHash: 'x', bodyText: '' };

	it('counts only the function own lines, not the body of nested functions', () => {
		const lines = new Map([[11, 1], [12, 0], [15, 0], [21, 0]]);
		expect(functionCoverage(fn, lines)).toBe(0.5);
	});

	it('keeps the first and last line of a nested function for the outer one, which holds code there too', () => {
		const oneLineCallbacks: FunctionInfo = { ...fn, nestedRanges: [[11, 11], [12, 12]] };
		expect(functionCoverage(oneLineCallbacks, new Map([[11, 0], [12, 0], [13, 1]]))).toBeCloseTo(1 / 3);
	});

	it('ignores its first and last line when other code shares them (they run when the module loads)', () => {
		const inline: FunctionInfo = { ...fn, nestedRanges: [], sharedLines: [10, 20] };
		expect(functionCoverage(inline, new Map([[10, 1], [15, 0], [20, 1]]))).toBe(0);
	});

	it('still counts a one-line function, where the shared line is the only evidence it ran', () => {
		const oneLine: FunctionInfo = { ...fn, startLine: 10, endLine: 10, nestedRanges: [], sharedLines: [10] };
		expect(functionCoverage(oneLine, new Map([[10, 5]]))).toBe(1);
	});

	it('treats a function missing from the report as untested', () => {
		expect(functionCoverage(fn, undefined)).toBe(0);
		expect(functionCoverage(fn, new Map([[1, 1]]))).toBe(0);
	});
});

describe('source map check', () => {
	const source = 'function f() {\n\treturn 1;\n}\n\n// note\n';

	it('accepts coverage on code lines', () => {
		expect(looksSourceMapped(source, new Map([[1, 1], [2, 1]]))).toBe(true);
	});

	it('flags coverage on blank lines, comments or past the end (transpiled line numbers)', () => {
		expect(looksSourceMapped(source, new Map([[4, 1], [5, 1], [40, 1]]))).toBe(false);
	});
});

describe('CRAP', () => {
	it('is complexity squared times uncovered cubed, plus complexity', () => {
		expect(crapScore(5, 0)).toBe(30);
		expect(crapScore(5, 1)).toBe(5);
		expect(crapScore(10, 0.5)).toBe(22.5);
	});
});
