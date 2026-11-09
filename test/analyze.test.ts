import { describe, expect, it } from 'vitest';
import { checkChange, type CheckInput } from '../src/analyze.js';
import { DEFAULTS, type Config } from '../src/config.js';
import { markdownReport } from '../src/report.js';

const config: Config = {
	...DEFAULTS,
	packages: [{ root: '.', coverage: 'coverage/lcov.info' }],
	reviewTiers: [
		{ name: 'billing', paths: ['src/billing/**'], reviewers: 2, effort: 'xhigh' },
		{ name: 'code', paths: ['src/**/*.ts'], reviewers: 1, effort: 'high' }
	]
};

const branchy = `export function price(plan, seats, coupon) {
	if (plan === 'pro' && seats > 10) return 1;
	if (coupon || seats === 0) return 2;
	return seats > 5 ? 3 : 4;
}
`;

function input(overrides: Partial<CheckInput> = {}): CheckInput {
	return {
		repoRoot: '/repo',
		config,
		changes: [{ file: 'src/billing/price.ts', addedLines: new Set([2]) }],
		coverage: new Map(),
		readCurrent: () => branchy,
		readBase: () => undefined,
		...overrides
	};
}

describe('checking a change', () => {
	it('fails an untested new function over the threshold and suggests the strictest review', () => {
		const result = checkChange(input());
		expect(result.failed).toBe(true);
		expect(result.verdicts).toHaveLength(1);
		expect(result.verdicts[0]).toMatchObject({ name: 'price', complexity: 6, coverage: 0, crap: 42, kind: 'new', status: 'fail' });
		expect(result.tier?.name).toBe('billing');
	});

	it('passes the same function once tests cover it', () => {
		const coverage = new Map([['/repo/src/billing/price.ts', new Map([[2, 1], [3, 1], [4, 1]])]]);
		const result = checkChange(input({ coverage }));
		expect(result.failed).toBe(false);
		expect(result.verdicts[0]).toMatchObject({ coverage: 1, crap: 6, status: 'ok' });
	});

	it('only warns when an untested old function gets a change without getting more complex', () => {
		const result = checkChange(input({ readBase: () => branchy }));
		expect(result.failed).toBe(false);
		expect(result.verdicts[0]).toMatchObject({ kind: 'changed', status: 'warn' });
	});

	it('shows the baseline CRAP but judges an old function by its complexity from the base source', () => {
		const baseline = { sha: 'abc', createdAt: '', files: { 'src/billing/price.ts': [{ name: 'price', bodyHash: 'x', complexity: 6, crap: 10 }] } };
		const result = checkChange(input({ baseline, readBase: () => branchy }));
		expect(result.verdicts[0]).toMatchObject({ status: 'warn', base: { crap: 10, complexity: 6 } });
		expect(markdownReport(result, 30)).toContain('Let through, not blocked: 1 existing function(s) over CRAP 30');
		const simpler = branchy.replace(' || seats === 0', '');
		expect(checkChange(input({ readBase: () => simpler })).verdicts[0]).toMatchObject({ status: 'fail' });
	});

	it('ignores names an older baseline wrote: verdicts come from the base source', () => {
		const old = { sha: 'abc', createdAt: '', files: { 'src/billing/price.ts': [{ name: '<anonymous>', bodyHash: 'x', complexity: 1, crap: 1 }] } };
		expect(checkChange(input({ baseline: old, readBase: () => branchy })).verdicts[0]).toMatchObject({ kind: 'changed', status: 'warn' });
	});

	it('suggests review for deleted files and for the old path of a renamed file', () => {
		const deleted = checkChange(input({ changes: [{ file: 'src/billing/charge.ts', previousFile: 'src/billing/charge.ts', deleted: true, addedLines: new Set() }] }));
		expect(deleted).toMatchObject({ verdicts: [], tier: { name: 'billing' } });
		const renamed = checkChange(input({ changes: [{ file: 'lib/refund.ts', previousFile: 'src/billing/refund.ts', addedLines: new Set() }] }));
		expect(renamed.tier?.name).toBe('billing');
	});

	it('does not score files outside every configured package', () => {
		const result = checkChange(input({ config: { ...config, packages: [{ root: 'app', coverage: 'lcov.info' }] } }));
		expect(result.verdicts).toEqual([]);
	});

	it('passes a text or markup change at once and suggests no review', () => {
		const result = checkChange(
			input({
				changes: [
					{ file: 'README.md', addedLines: new Set([1]) },
					{ file: 'src/page.html', addedLines: new Set([1]) }
				]
			})
		);
		expect(result).toMatchObject({ failed: false, verdicts: [] });
		expect(result.tier).toBeUndefined();
	});

	it('neither scores nor suggests review for changes to tests or config only', () => {
		const result = checkChange(
			input({
				changes: [
					{ file: 'src/price.test.ts', addedLines: new Set([1]) },
					{ file: 'src/vite.config.ts', addedLines: new Set([1]) }
				]
			})
		);
		expect(result).toMatchObject({ failed: false, verdicts: [] });
		expect(result.tier).toBeUndefined();
	});

	it('warns when coverage does not line up with the source', () => {
		const coverage = new Map([['/repo/src/billing/price.ts', new Map([[6, 1], [80, 1]])]]);
		expect(checkChange(input({ coverage })).warnings[0]).toMatch(/do not match the source/);
	});
});

describe('the report', () => {
	it('is a Markdown table with the review suggestion', () => {
		const text = markdownReport(checkChange(input()), 30);
		expect(text).toContain('| 42.0 | 6 | 0% | `src/billing/price.ts:1` price | ✗ new: new function over 30 |');
		expect(text).toContain('1 function(s) checked against CRAP 30: 1 failed, 0 let through.');
		expect(text).toContain('Suggested review: **billing**, 2 reviewer(s), xhigh');
	});

	it('says so when no function changed', () => {
		expect(markdownReport(checkChange(input({ changes: [] })), 30)).toContain('No changed JavaScript or TypeScript functions.');
	});
});
