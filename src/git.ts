/** What a change touches, read from git: changed files, their added lines and their base version. */
import { execFileSync } from 'node:child_process';

export type FileChange = {
	/** Path in the change (repo-relative); for a deleted file, its old path. */
	file: string;
	/** Path before the change, when the file was renamed, copied or deleted. */
	previousFile?: string;
	deleted?: boolean;
	/** Lines added or modified in the new version. */
	addedLines: Set<number>;
};

const git = (cwd: string, args: string[]) =>
	execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export const repoRoot = (cwd: string) => git(cwd, ['rev-parse', '--show-toplevel']).trim();

/** Directory shared by all worktrees of the repository, for the baseline cache. */
export function gitCommonDir(cwd: string): string {
	return git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
}

export function mergeBase(cwd: string, base: string, ref = 'HEAD'): string {
	return git(cwd, ['merge-base', base, ref]).trim();
}

export function headSha(cwd: string): string {
	return git(cwd, ['rev-parse', 'HEAD']).trim();
}

/** The file at `ref`, or undefined when it did not exist there. */
export function fileAt(cwd: string, ref: string, file: string): string | undefined {
	try {
		return git(cwd, ['show', `${ref}:${file}`]);
	} catch {
		return undefined;
	}
}

/** Tracked files, NUL-separated so any file name survives. */
export function trackedFiles(cwd: string): string[] {
	return git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean);
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A path as git prints it: plain, or C-quoted ("...") with escapes and octal UTF-8 bytes. */
export function unquoteGitPath(raw: string): string {
	if (!(raw.startsWith('"') && raw.endsWith('"'))) return raw;
	const bytes: number[] = [];
	const body = raw.slice(1, -1);
	for (let i = 0; i < body.length; i++) {
		const char = body[i];
		if (char !== '\\') {
			bytes.push(...Buffer.from(char, 'utf8'));
			continue;
		}
		const next = body[++i];
		if (/[0-7]/.test(next)) {
			bytes.push(parseInt(body.slice(i, i + 3), 8));
			i += 2;
		} else bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
	}
	return Buffer.from(bytes).toString('utf8');
}

/** The path of a `--- a/x` or `+++ b/x` line; git ends it with a tab when the name has a space. */
function headerPath(line: string, prefix: 'a/' | 'b/'): string | undefined {
	const raw = line.slice(4).replace(/\t$/, '');
	if (raw === '/dev/null') return undefined;
	const path = unquoteGitPath(raw);
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

type ParseState = { changes: FileChange[]; current?: FileChange; oldPath?: string };

function handleHeader(line: string, state: ParseState): boolean {
	const moved = /^(?:rename|copy) from (.+)$/.exec(line);
	if (moved) {
		state.changes.push((state.current = { file: '', previousFile: unquoteGitPath(moved[1]), addedLines: new Set() }));
		return true;
	}
	if (line.startsWith('--- ')) {
		state.oldPath = headerPath(line, 'a/');
		return true;
	}
	if (!line.startsWith('+++ ')) return false;
	const file = headerPath(line, 'b/');
	if (file === undefined) {
		if (state.oldPath) state.changes.push({ file: state.oldPath, previousFile: state.oldPath, deleted: true, addedLines: new Set() });
		state.current = undefined;
	} else if (state.current && state.current.file === '') state.current.file = file;
	else state.changes.push((state.current = { file, addedLines: new Set() }));
	return true;
}

/**
 * Parses `git diff -U0 -M` output into the added line numbers per new file, plus deletions.
 * Hunk headers look like `@@ -12,3 +14,5 @@`; a missing count means 1.
 */
export function parseUnifiedDiff(diff: string): FileChange[] {
	const state: ParseState = { changes: [] };
	for (const line of diff.split('\n')) {
		if (line.startsWith('diff --git ')) {
			state.current = undefined;
			state.oldPath = undefined;
			continue;
		}
		if (handleHeader(line, state)) continue;
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk && state.current) {
			const start = Number(hunk[1]);
			const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
			for (let offset = 0; offset < count; offset++) state.current.addedLines.add(start + offset);
		}
	}
	return state.changes.filter((change) => change.file !== '');
}

/** Same output whatever the user's git config: no external diff, textconv, custom prefixes or quoting. */
const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];

/** Files changed between `base` and `ref`, or the working tree (committed or not) without `ref`. */
export function changedFiles(cwd: string, base: string, ref?: string): FileChange[] {
	return parseUnifiedDiff(git(cwd, [...DIFF, '-U0', '-M', base, ...(ref ? [ref] : [])]));
}

/** Which of `files` differ between `ref` and the working tree. */
export function filesDifferingFrom(cwd: string, ref: string, files: string[]): string[] {
	if (files.length === 0) return [];
	return git(cwd, [...DIFF, '--name-only', '-z', ref, '--', ...files]).split('\0').filter(Boolean);
}
