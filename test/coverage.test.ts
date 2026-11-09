import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionCoverage, looksSourceMapped, mergeCoverage, parseIstanbulJson, parseLcov } from '../src/coverage.js';
import { crapScore } from '../src/crap.js';
import type { FunctionInfo } from '../src/functions.js';

const root = '/repo/pkg';

describe('reading coverage', () => {
	it('reads LCOV line hits, resolving paths against the package root', () => {
		const coverage = parseLcov('TN:\nSF:src/a.ts\nDA:1,3\nDA:2,0\nend_of_record\nSF:/abs/b.ts\nDA:5,1\nend_of_record\n', root);
		expect(new Map(coverage.get(path.resolve(root, 'src/a.ts')))).toEqual(new Map([[1, 3], [2, 0]]));
		expect(new Map(coverage.get('/abs/b.ts'))).toEqual(new Map([[5, 1]]));
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
		expect(new Map(coverage.get('/repo/pkg/src/a.ts'))).toEqual(new Map([[2, 2], [4, 0]]));
	});

	it('merges reports, keeping the highest hit count per line', () => {
		const merged = mergeCoverage(new Map([['/f', new Map([[1, 0]])]]), new Map([['/f', new Map([[1, 2], [3, 1]])]]));
		expect(new Map(merged.get('/f'))).toEqual(new Map([[1, 2], [3, 1]]));
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

	it('does not count a one-line function the report says was never called', () => {
		const oneLine: FunctionInfo = { ...fn, startLine: 1, endLine: 1, nestedRanges: [], sharedLines: [1] };
		const lcov = (calls: number) => `SF:src/a.ts\nFN:1,choose\nFNDA:${calls},choose\nDA:1,1\nend_of_record\n`;
		const file = path.resolve(root, 'src/a.ts');
		expect(functionCoverage(oneLine, parseLcov(lcov(0), root).get(file))).toBe(0);
		expect(functionCoverage(oneLine, parseLcov(lcov(3), root).get(file))).toBe(1);
	});

	it('reads function calls from istanbul JSON and keeps them when reports merge', () => {
		const oneLine: FunctionInfo = { ...fn, startLine: 1, endLine: 1, nestedRanges: [], sharedLines: [1] };
		const report = (calls: number) =>
			parseIstanbulJson(
				JSON.stringify({
					'/repo/pkg/src/a.ts': {
						statementMap: { '0': { start: { line: 1 } } },
						s: { '0': 1 },
						fnMap: { '0': { name: 'choose', decl: { start: { line: 1 } } } },
						f: { '0': calls }
					}
				}),
				root
			);
		expect(functionCoverage(oneLine, report(0).get('/repo/pkg/src/a.ts'))).toBe(0);
		const merged = mergeCoverage(report(0), report(2));
		expect(functionCoverage(oneLine, merged.get('/repo/pkg/src/a.ts'))).toBe(1);
	});

	it('ignores function records for a function with lines of its own', () => {
		const lcov = 'SF:src/a.ts\nFN:10,f\nFNDA:0,f\nDA:10,1\nDA:11,1\nDA:12,1\nend_of_record\n';
		const lines = parseLcov(lcov, root).get(path.resolve(root, 'src/a.ts'));
		expect(functionCoverage({ ...fn, nestedRanges: [], sharedLines: [10] }, lines)).toBe(1);
	});

	it('matches repeated function names in LCOV by occurrence', () => {
		const lcov = 'SF:src/a.ts\nFN:1,choose\nFN:2,choose\nFNDA:0,choose\nFNDA:1,choose\nDA:1,1\nDA:2,1\nend_of_record\n';
		const lines = parseLcov(lcov, root).get(path.resolve(root, 'src/a.ts'));
		const at = (line: number): FunctionInfo => ({ ...fn, name: 'b', startLine: line, endLine: line, nestedRanges: [], sharedLines: [line] });
		expect(functionCoverage({ ...at(1), name: 'a' }, lines)).toBe(0);
		expect(functionCoverage({ ...at(2), name: 'b' }, lines)).toBe(1);
	});

	it('does not blame a called function for an uncalled neighbour on its line', () => {
		const lcov = 'SF:src/a.ts\nFN:1,pick\nFN:1,spare\nFNDA:4,pick\nFNDA:0,spare\nDA:1,1\nend_of_record\n';
		const lines = parseLcov(lcov, root).get(path.resolve(root, 'src/a.ts'));
		const oneLine = (name: string): FunctionInfo => ({ ...fn, name, startLine: 1, endLine: 1, nestedRanges: [], sharedLines: [1] });
		expect(functionCoverage(oneLine('pick'), lines)).toBe(1);
		expect(functionCoverage(oneLine('spare'), lines)).toBe(0);
	});

	it('does not count an uncalled one-line declaration that shares its line with nothing', () => {
		const lcov = 'SF:src/a.ts\nFN:1,choose\nFNDA:0,choose\nDA:1,1\nend_of_record\n';
		const lines = parseLcov(lcov, root).get(path.resolve(root, 'src/a.ts'));
		expect(functionCoverage({ ...fn, name: 'choose', startLine: 1, endLine: 1, nestedRanges: [], sharedLines: [] }, lines)).toBe(0);
	});

	it('pairs records with same-line functions in source order (getter and setter, returned callback)', () => {
		const lcov = 'SF:src/a.ts\nFN:1,get price\nFN:1,set price\nFNDA:0,get price\nFNDA:1,set price\nDA:1,1\nend_of_record\n';
		const lines = parseLcov(lcov, root).get(path.resolve(root, 'src/a.ts'));
		const at = (name: string, index: number): FunctionInfo => ({
			...fn, name, startLine: 1, endLine: 1, nestedRanges: [], sharedLines: [1], onLine: { index, count: 2 }
		});
		expect(functionCoverage(at('box.price', 0), lines)).toBe(0);
		expect(functionCoverage(at('box.price#2', 1), lines)).toBe(1);
		const node = parseLcov('SF:src/b.ts\nFN:9,build\nFN:9,anonymous_4\nFNDA:1,build\nFNDA:0,anonymous_4\nDA:9,1\nend_of_record\n', root);
		const callback: FunctionInfo = { ...fn, name: 'build/<anonymous>', startLine: 9, endLine: 9, nestedRanges: [], sharedLines: [9], onLine: { index: 1, count: 2 } };
		expect(functionCoverage(callback, node.get(path.resolve(root, 'src/b.ts')))).toBe(0);
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

	it('flags coverage on blank lines or past the end (transpiled line numbers)', () => {
		expect(looksSourceMapped(source, new Map([[4, 1], [40, 1]]))).toBe(false);
	});

	it('accepts reports that list comment lines (node:test)', () => {
		expect(looksSourceMapped(source, new Map([[1, 1], [2, 1], [5, 1]]))).toBe(true);
	});
});

describe('CRAP', () => {
	it('is complexity squared times uncovered cubed, plus complexity', () => {
		expect(crapScore(5, 0)).toBe(30);
		expect(crapScore(5, 1)).toBe(5);
		expect(crapScore(10, 0.5)).toBe(22.5);
	});
});
