/**
 * The CLI in a throwaway git repository: a base branch, a change on top, a hand-written LCOV
 * report (`--no-run`), the baseline cache and the exit codes.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../src/cli.js';

let repo: string;
let cwd: string;
let output: string[];

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), text);
};
const commit = (message: string) => {
	git('add', '-A');
	git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message);
};
const run = (...args: string[]) => {
	output = [];
	return main(args);
};

const simple = 'export function add(a, b) {\n\treturn a + b;\n}\n';
const branchy = `export function price(plan, seats, coupon) {
	if (plan === 'pro' && seats > 10) return 1;
	if (coupon || seats === 0) return 2;
	return seats > 5 ? 3 : 4;
}
`;

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crap-check-'));
	git('init', '-q', '-b', 'main');
	write('crap.config.json', JSON.stringify({ base: 'main', packages: [{ root: '.', coverage: 'lcov.info' }] }));
	write('src/add.ts', simple);
	write('lcov.info', 'SF:src/add.ts\nDA:2,1\nend_of_record\n');
	commit('base');
	git('checkout', '-qb', 'feature');
	cwd = process.cwd();
	process.chdir(repo);
	vi.spyOn(console, 'log').mockImplementation((text: string) => void output.push(text));
	vi.spyOn(console, 'error').mockImplementation((text: string) => void output.push(text));
});

afterEach(() => {
	process.chdir(cwd);
	vi.restoreAllMocks();
	fs.rmSync(repo, { recursive: true, force: true });
});

describe('crap-check', () => {
	it('passes a change that touches no function', () => {
		write('README.md', '# Title\n');
		commit('docs');
		expect(run('--no-run')).toBe(0);
		expect(output.join('\n')).toContain('No changed JavaScript or TypeScript functions.');
	});

	it('fails with exit 1 on an untested new function over the threshold', () => {
		write('src/price.ts', branchy);
		commit('price');
		expect(run('--no-run')).toBe(1);
		expect(output.join('\n')).toContain('| 42.0 | 6 | 0% | `src/price.ts:1` price | ✗ new: new function over 30 |');
	});

	it('passes once the coverage report covers it', () => {
		write('src/price.ts', branchy);
		write('lcov.info', 'SF:src/price.ts\nDA:2,1\nDA:3,1\nDA:4,1\nend_of_record\n');
		commit('price with tests');
		expect(run('--no-run')).toBe(0);
	});

	it('compares a changed function with the stored baseline of the base commit', () => {
		git('checkout', '-q', 'main');
		write('src/add.ts', `export function add(a, b) {\n\treturn a && b ? a + b : 0;\n}\n`);
		commit('base add');
		expect(run('baseline', '--no-run')).toBe(0);
		expect(output.join('\n')).toMatch(/Baseline for [0-9a-f]{12}: 1 functions/);
		git('checkout', '-qb', 'feature-2');
		write('src/add.ts', `export function add(a, b) {\n\treturn a && b ? a + b : a || b || 0;\n}\n`);
		commit('add more branches');
		expect(run('--no-run', '--json')).toBe(0);
		const result = JSON.parse(output[0]);
		expect(result.verdicts[0]).toMatchObject({ name: 'add', kind: 'changed', base: { crap: 3 } });
	});

	it('lists the worst functions of the project with --all', () => {
		write('src/price.ts', branchy);
		commit('price');
		expect(run('--all', '--no-run')).toBe(0);
		expect(output[0].split('\n')[2]).toContain('price');
	});

	it('runs the test command, warns about failing tests and still reads the fresh coverage', () => {
		const writeCoverage = "printf 'SF:src/price.ts\\nDA:2,1\\nDA:3,1\\nDA:4,1\\nend_of_record\\n' > lcov.info";
		write(
			'crap.config.json',
			JSON.stringify({ base: 'main', packages: [{ root: '.', coverage: 'lcov.info', test: `${writeCoverage}; exit 1` }] })
		);
		write('src/price.ts', branchy);
		commit('price, tests failing');
		expect(run()).toBe(0);
		expect(output.join('\n')).toContain('Warning: tests failed in .; coverage may be incomplete');
		expect(output.join('\n')).toContain('| 6.0 | 6 | 100% |');
	});

	it('never reads a coverage report left over from an earlier run', () => {
		write('crap.config.json', JSON.stringify({ base: 'main', packages: [{ root: '.', coverage: 'lcov.info', test: 'true' }] }));
		write('src/price.ts', branchy);
		write('lcov.info', 'SF:src/price.ts\nDA:2,1\nDA:3,1\nDA:4,1\nend_of_record\n');
		commit('price with a stale report');
		expect(run()).toBe(1);
		expect(output.join('\n')).toContain('no coverage report at lcov.info');
	});

	it('with --ref judges the pushed commit, not an uncommitted fix in the working tree', () => {
		write('src/price.ts', branchy);
		commit('untested price');
		write('src/price.ts', 'export function price() {\n\treturn 1;\n}\n');
		expect(run('--no-run', '--ref', 'HEAD')).toBe(1);
		expect(output.join('\n')).toContain('`src/price.ts:1` price | ✗ new');
		expect(output.join('\n')).toMatch(/the working tree differs from HEAD in src\/price\.ts/);
		expect(run('--no-run')).toBe(0); // without --ref the working tree counts
	});

	it('scores only files inside a configured package', () => {
		write('crap.config.json', JSON.stringify({ base: 'main', packages: [{ root: 'app', coverage: 'lcov.info' }] }));
		write('tools/price.ts', branchy);
		commit('untested code outside the package');
		expect(run('--no-run')).toBe(0);
		expect(output.join('\n')).toContain('No changed JavaScript or TypeScript functions.');
	});

	it('exits 2 with a message when something is wrong', () => {
		expect(run('--base', 'no-such-branch', '--no-run')).toBe(2);
		expect(output.join('\n')).toMatch(/^crap-check: /);
	});
});

describe('arguments', () => {
	it('parses commands and options', () => {
		expect(parseArgs(['baseline', '--output', 'b.json', '--no-run'])).toMatchObject({
			command: 'baseline',
			output: 'b.json',
			run: false
		});
		expect(() => parseArgs(['--base'])).toThrow('--base needs a value');
		expect(() => parseArgs(['--what'])).toThrow('Unknown argument: --what');
	});
});
