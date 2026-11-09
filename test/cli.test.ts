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
	it('prints help and the version', () => {
		expect(run('--help')).toBe(0);
		expect(output.join('\n')).toContain('Usage: crap-check');
		expect(run('--version')).toBe(0);
		expect(output.join('\n')).toMatch(/^\d+\.\d+\.\d+$/);
	});

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
		expect(run()).toBe(2);
		expect(output.join('\n')).toContain('no coverage report at lcov.info');
		expect(output.join('\n')).toContain('| – | 6 | – | `src/price.ts:1` price | ? new: not measured (no coverage report) |');
	});

	it('--all and baseline give no numbers for a package without a coverage report', () => {
		write('crap.config.json', JSON.stringify({ base: 'main', packages: [{ root: '.', coverage: 'missing.info' }] }));
		commit('no report');
		expect(run('--all', '--no-run')).toBe(2);
		expect(output.join('\n')).toContain('Not measured (no coverage report, left out): .');
		expect(run('baseline', '--no-run', '--output', path.join(repo, 'b.json'))).toBe(2);
		expect(fs.existsSync(path.join(repo, 'b.json'))).toBe(false);
	});

	it('runs no tests when the change touches no function, only text in a source file', () => {
		write('crap.config.json', JSON.stringify({ base: 'main', packages: [{ root: '.', coverage: 'lcov.info', test: 'exit 7' }] }));
		write('src/copy.ts', 'export const title = "Old";\n');
		commit('copy');
		git('checkout', '-q', 'main');
		git('merge', '-q', 'feature');
		git('checkout', '-qb', 'edit');
		write('src/copy.ts', 'export const title = "New";\n');
		commit('edit copy');
		expect(run()).toBe(0);
		expect(output.join('\n')).not.toContain('tests failed');
	});

	it('still fails a measured package while another one has no report', () => {
		write('crap.config.json', JSON.stringify({
			base: 'main',
			packages: [{ root: 'a', coverage: 'lcov.info' }, { root: 'b', coverage: 'lcov.info' }]
		}));
		write('a/price.ts', branchy);
		write('a/lcov.info', 'SF:price.ts\nDA:9,1\nend_of_record\n');
		write('b/other.ts', branchy.replace('price', 'other'));
		commit('two packages');
		expect(run('--no-run')).toBe(1);
		expect(output.join('\n')).toContain('✗ new');
		expect(output.join('\n')).toContain('? new: not measured');
	});

	it('with --ref judges the pushed commit, and refuses while the package has uncommitted changes', () => {
		write('src/price.ts', branchy);
		commit('untested price');
		expect(run('--no-run', '--ref', 'HEAD')).toBe(1);
		expect(output.join('\n')).toContain('`src/price.ts:1` price | ✗ new');
		write('src/price.ts', 'export function price() {\n\treturn 1;\n}\n');
		write('src/price.test.ts', "it('covers price', () => {});\n");
		expect(run('--no-run', '--ref', 'HEAD')).toBe(2);
		expect(output.join('\n')).toMatch(/uncommitted changes in \. \(.*src\/price\.ts.*\): commit or stash them first/);
		expect(run('--no-run')).toBe(0); // without --ref the working tree counts
	});

	it('with --ref reads the config from the commit and ignores uncommitted non-code files', () => {
		write('src/price.ts', branchy);
		commit('untested price');
		write('crap.config.json', JSON.stringify({ base: 'main', threshold: 50, packages: [{ root: '.', coverage: 'lcov.info' }] }));
		write('NOTES.txt', 'scratch\n');
		expect(run('--no-run', '--ref', 'HEAD')).toBe(1); // the committed threshold, 30, applies
	});

	it('with --ref refuses an uncommitted test fixture, which could lend coverage', () => {
		write('src/price.ts', branchy);
		commit('untested price');
		write('src/cases.json', '[1, 2, 3]\n');
		expect(run('--no-run', '--ref', 'HEAD')).toBe(2);
		expect(output.join('\n')).toMatch(/uncommitted changes in \. \(src\/cases\.json\)/);
	});

	it('with --ref is not stopped by the coverage report a previous run left behind', () => {
		write('crap.config.json', JSON.stringify({ base: 'main', packages: [{ root: '.', coverage: 'coverage/lcov.info' }] }));
		write('src/math.ts', simple);
		commit('add');
		write('coverage/lcov.info', 'SF:src/math.ts\nDA:2,1\nend_of_record\n');
		write('coverage/lcov-report/index.html', '<html></html>\n');
		expect(run('--no-run', '--ref', 'HEAD')).toBe(0);
		write('src/notes.json', '{}\n');
		expect(run('--no-run', '--ref', 'HEAD')).toBe(2);
	});

	it('does not let a same-named callback inserted above an old one pass as the old one', () => {
		git('checkout', '-q', 'main');
		const handler = (body: string) => `app.use((req, res) => {\n${body}\n});\n`;
		const old = handler("\tif (req.a && req.b) return 1;\n\tif (req.c || req.d) return 2;\n\treturn req.e ? 3 : 4;");
		write('src/routes.ts', old);
		commit('old handler');
		git('checkout', '-qb', 'insert');
		const inserted = handler("\tif (req.x && req.y) return 5;\n\tif (req.z || req.w) return 6;\n\treturn req.v ? 7 : 8;");
		write('src/routes.ts', inserted + old);
		commit('insert a new handler above');
		expect(run('--no-run', '--base', 'main')).toBe(1);
		expect(output.join('\n')).toContain('app.use(<callback>) | ✗ new');
	});

	it('treats a copy inside a renamed file as new', () => {
		git('checkout', '-q', 'main');
		write('src/legacy.ts', branchy);
		commit('legacy');
		git('checkout', '-qb', 'rename-copy');
		fs.rmSync(path.join(repo, 'src/legacy.ts'));
		write('src/renamed.ts', `${branchy}\n${branchy.replace('price', 'priceCopy')}`);
		commit('rename with a copy');
		expect(run('--no-run', '--base', 'main')).toBe(1);
		expect(output.join('\n')).toContain('priceCopy | ✗ new');
	});

	it('scores only files inside a configured package', () => {
		write('crap.config.json', JSON.stringify({ base: 'main', packages: [{ root: 'app', coverage: 'lcov.info' }] }));
		write('tools/price.ts', branchy);
		commit('untested code outside the package');
		expect(run('--no-run')).toBe(0);
		expect(output.join('\n')).toContain('No changed JavaScript or TypeScript functions.');
	});

	it('sees the change whatever the user git config says about diffs', () => {
		write('src/price.ts', branchy);
		commit('price');
		git('config', 'diff.mnemonicPrefix', 'true');
		git('config', 'diff.noprefix', 'true');
		git('config', 'diff.external', 'false');
		expect(run('--no-run')).toBe(1);
	});

	it('sees files with spaces and non-ASCII characters in their names', () => {
		write('src/ünï.ts', branchy);
		write('src/with space.ts', branchy.replace('price', 'price2'));
		commit('odd names');
		expect(run('--no-run')).toBe(1);
		const text = output.join('\n');
		expect(text).toContain('src/ünï.ts:1');
		expect(text).toContain('src/with space.ts:1');
	});

	it('treats an untested function moved to another file as moved, not new', () => {
		git('checkout', '-q', 'main');
		write('src/legacy.ts', `${simple}\n${branchy}`);
		commit('legacy');
		git('checkout', '-qb', 'move');
		write('src/legacy.ts', simple);
		write('src/moved.ts', branchy);
		commit('move price out');
		expect(run('--no-run', '--base', 'main')).toBe(0);
		expect(output.join('\n')).toContain('⚠ moved');
	});

	it('treats a copy of an untested function that still exists as new', () => {
		git('checkout', '-q', 'main');
		write('src/legacy.ts', branchy);
		commit('legacy');
		git('checkout', '-qb', 'copy');
		write('src/legacy.ts', `${branchy}\n${branchy.replace('price', 'priceCopy')}`);
		commit('copy');
		expect(run('--no-run', '--base', 'main')).toBe(1);
		expect(output.join('\n')).toContain('priceCopy | ✗ new');
	});

	it('does not read a coverage report when the package has no test command to refresh it', () => {
		write('src/price.ts', branchy);
		write('lcov.info', 'SF:src/price.ts\nDA:2,1\nDA:3,1\nDA:4,1\nend_of_record\n');
		commit('price with a stale report');
		expect(run()).toBe(1);
		expect(output.join('\n')).toContain('has no "test" command: its functions count as untested');
	});

	it('adds a custom exclude to the default ones instead of replacing them', () => {
		write('crap.config.json', JSON.stringify({ base: 'main', exclude: ['legacy/**'], packages: [{ root: '.', coverage: 'lcov.info' }] }));
		write('src/price.test.ts', `it('x', () => { ${branchy} });\n`);
		write('legacy/old.ts', branchy);
		commit('test and legacy');
		expect(run('--no-run')).toBe(0);
	});

	it('runs from an install path with spaces', () => {
		const install = fs.mkdtempSync(path.join(os.tmpdir(), 'inst dir with space-'));
		fs.cpSync(path.resolve(cwd, 'dist'), path.join(install, 'dist'), { recursive: true });
		fs.symlinkSync(path.resolve(cwd, 'node_modules'), path.join(install, 'node_modules'));
		fs.writeFileSync(path.join(install, 'package.json'), '{"type":"module"}');
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
		let status = 0;
		try {
			execFileSync('node', [path.join(install, 'dist/cli.js')], { cwd: outside, stdio: 'pipe' });
		} catch (error) {
			status = (error as { status: number }).status;
		}
		fs.rmSync(install, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
		expect(status).toBe(2); // "not a git repository", not a crash
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
