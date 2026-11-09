/** What a change touches, read from git: changed files, their added lines and their base version. */
import { execFileSync } from 'node:child_process';
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
export const repoRoot = (cwd) => git(cwd, ['rev-parse', '--show-toplevel']).trim();
/** Directory shared by all worktrees of the repository, for the baseline cache. */
export function gitCommonDir(cwd) {
    return git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
}
export function mergeBase(cwd, base, ref = 'HEAD') {
    return git(cwd, ['merge-base', base, ref]).trim();
}
export function headSha(cwd) {
    return git(cwd, ['rev-parse', 'HEAD']).trim();
}
/** The file at `ref`, or undefined when it did not exist there. */
export function fileAt(cwd, ref, file) {
    try {
        return git(cwd, ['show', `${ref}:${file}`]);
    }
    catch {
        return undefined;
    }
}
/**
 * Parses `git diff -U0 -M` output into the added line numbers per new file.
 * Hunk headers look like `@@ -12,3 +14,5 @@`; a missing count means 1.
 */
export function parseUnifiedDiff(diff) {
    const changes = [];
    let current;
    for (const line of diff.split('\n')) {
        if (line.startsWith('diff --git ')) {
            current = undefined;
            continue;
        }
        const renamedFrom = /^rename from (.+)$/.exec(line) ?? /^copy from (.+)$/.exec(line);
        if (renamedFrom) {
            changes.push((current = { file: '', previousFile: renamedFrom[1], addedLines: new Set() }));
            continue;
        }
        if (line.startsWith('+++ ')) {
            const target = line.slice(4);
            if (target === '/dev/null')
                continue;
            const file = target.replace(/^b\//, '');
            if (current && current.file === '')
                current.file = file;
            else
                changes.push((current = { file, addedLines: new Set() }));
            continue;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk && current) {
            const start = Number(hunk[1]);
            const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
            for (let offset = 0; offset < count; offset++)
                current.addedLines.add(start + offset);
        }
    }
    return changes.filter((change) => change.file !== '');
}
/** Files changed between `base` and `ref`, or the working tree (committed or not) without `ref`. */
export function changedFiles(cwd, base, ref) {
    return parseUnifiedDiff(git(cwd, ['diff', '-U0', '-M', '--no-color', base, ...(ref ? [ref] : [])]));
}
/** Which of `files` differ between `ref` and the working tree. */
export function filesDifferingFrom(cwd, ref, files) {
    if (files.length === 0)
        return [];
    return git(cwd, ['diff', '--name-only', ref, '--', ...files]).split('\n').filter(Boolean);
}
