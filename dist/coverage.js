/**
 * Line coverage from the report a test runner writes: LCOV (`lcov.info`, vitest and jest) or an
 * istanbul/v8 JSON report (`coverage-final.json`). Both become hit counts per line per file.
 */
import fs from 'node:fs';
import path from 'node:path';
/**
 * Hits per line of one file. `calls` holds the report's function records, when it has them:
 * start line -> function key -> times called. They tell a function that ran from a line that only
 * ran because the module loaded.
 */
export class FileLines extends Map {
    calls = new Map();
}
function fileLines(coverage, file) {
    const existing = coverage.get(file);
    if (existing instanceof FileLines)
        return existing;
    const lines = new FileLines(existing ?? []);
    coverage.set(file, lines);
    return lines;
}
function addHits(coverage, file, line, hits) {
    const lines = fileLines(coverage, file);
    lines.set(line, Math.max(lines.get(line) ?? 0, hits));
}
function addCalls(coverage, file, line, key, hits) {
    const calls = fileLines(coverage, file).calls;
    let onLine = calls.get(line);
    if (!onLine)
        calls.set(line, (onLine = new Map()));
    onLine.set(key, Math.max(onLine.get(key) ?? 0, hits));
}
/** FNDA occurrences per name in the current file, for {@link readFunctionRecord}. */
let seen = new Map();
/**
 * `SF:` starts a file, `DA:<line>,<hits>` gives a line, `FN:<line>[,<end>],<name>` and
 * `FNDA:<hits>,<name>` give a function's calls; paths are resolved against `root`.
 */
export function parseLcov(text, root) {
    const coverage = new Map();
    let file;
    let starts = new Map();
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('SF:')) {
            file = path.resolve(root, line.slice(3));
            starts = new Map();
            seen = new Map();
        }
        else if (line === 'end_of_record')
            file = undefined;
        else if (!file)
            continue;
        else if (line.startsWith('DA:')) {
            const [lineNo, hits] = line.slice(3).split(',').map(Number);
            if (Number.isFinite(lineNo) && Number.isFinite(hits))
                addHits(coverage, file, lineNo, hits);
        }
        else
            readFunctionRecord(coverage, file, line, starts);
    }
    return coverage;
}
/**
 * `FN` gives a function's start line, `FNDA` its calls, matched by name. Names repeat (two
 * functions called `choose`), so the n-th `FNDA` of a name belongs to its n-th `FN`, and each
 * occurrence keeps its own key.
 */
function readFunctionRecord(coverage, file, line, starts) {
    const declared = /^FN:(\d+)(?:,\d+)?,(.+)$/.exec(line);
    if (declared) {
        const lines = starts.get(declared[2]) ?? [];
        starts.set(declared[2], [...lines, Number(declared[1])]);
        return;
    }
    const called = /^FNDA:(\d+),(.+)$/.exec(line);
    if (!called)
        return;
    const lines = starts.get(called[2]);
    const start = lines?.shift();
    if (start === undefined)
        return;
    const occurrence = (seen.get(called[2]) ?? 0) + 1;
    seen.set(called[2], occurrence);
    addCalls(coverage, file, start, `${called[2]}#${occurrence}`, Number(called[1]));
}
/** A statement counts on the line it starts; a function on the line it is declared. */
export function parseIstanbulJson(text, root) {
    const coverage = new Map();
    const report = JSON.parse(text);
    for (const [key, entry] of Object.entries(report)) {
        const file = path.resolve(root, entry.path ?? key);
        for (const [id, location] of Object.entries(entry.statementMap ?? {})) {
            addHits(coverage, file, location.start.line, entry.s?.[id] ?? 0);
        }
        for (const [id, fn] of Object.entries(entry.fnMap ?? {})) {
            const start = (fn.decl ?? fn.loc)?.start.line;
            if (start !== undefined)
                addCalls(coverage, file, start, `${fn.name ?? 'fn'}#${id}`, entry.f?.[id] ?? 0);
        }
    }
    return coverage;
}
export function readCoverage(file, root) {
    const text = fs.readFileSync(file, 'utf8');
    return file.endsWith('.json') ? parseIstanbulJson(text, root) : parseLcov(text, root);
}
export function mergeCoverage(target, source) {
    for (const [file, lines] of source) {
        for (const [line, hits] of lines)
            addHits(target, file, line, hits);
        if (!(lines instanceof FileLines))
            continue;
        for (const [line, onLine] of lines.calls) {
            for (const [key, hits] of onLine)
                addCalls(target, file, line, key, hits);
        }
    }
    return target;
}
/** Inside a nested function: its first and last line also hold the outer code around it. */
const inNestedBody = (line, ranges) => ranges.some(([start, end]) => line > start && line < end);
/**
 * Share of the function's own instrumented lines that ran: without the bodies of nested functions,
 * and without its first or last line when other code shares it. No such lines: untested, 0. A
 * function whose only lines run when the module loads counts 0 when the report's function records
 * say it was never called.
 */
export function functionCoverage(fn, lines) {
    if (!lines)
        return 0;
    const own = [...lines].filter(([line]) => line >= fn.startLine && line <= fn.endLine && !inNestedBody(line, fn.nestedRanges));
    // Shared first/last lines run with the surrounding code; drop them unless they are all there is.
    const unshared = own.filter(([line]) => !fn.sharedLines?.includes(line));
    // Lines inside a multi-line body only run when the function does; a one-line function's line
    // also runs when the module loads, so there the call records decide.
    const onlyLoadTimeLines = fn.startLine === fn.endLine || unshared.length === 0;
    if (onlyLoadTimeLines && ownCalls(fn, lines) === 0)
        return 0;
    const counted = unshared.length > 0 ? unshared : own;
    if (counted.length === 0)
        return 0;
    return counted.filter(([, hits]) => hits > 0).length / counted.length;
}
/** `outer/inner` -> `inner`, `Class.method` -> `method`; a callback's call name gives nothing to match. */
const simpleName = (name) => (name.includes('(') ? undefined : name.split(/[/.]/).pop());
/**
 * Calls of the function from the report's records on its first line: the record with its name,
 * else the only record there; with several unnamed records, 0 only when none of them was called.
 * Undefined when it cannot tell (no records, or an ambiguous mix).
 */
function ownCalls(fn, lines) {
    const records = lines instanceof FileLines ? lines.calls.get(fn.startLine) : undefined;
    if (!records || records.size === 0)
        return undefined;
    const name = simpleName(fn.name);
    const named = [...records].filter(([key]) => name !== undefined && key.replace(/#[^#]*$/, '') === name);
    if (named.length === 1)
        return named[0][1];
    if (records.size === 1)
        return [...records.values()][0];
    return [...records.values()].every((hits) => hits === 0) ? 0 : undefined;
}
/**
 * Whether a file's coverage looks mapped onto its source lines. Coverage of transpiled output (a
 * test runner without source maps) points at lines past the end or at blank lines. Comment lines
 * do not count against it: some reporters (node:test) list them.
 */
export function looksSourceMapped(sourceText, lines) {
    if (!lines || lines.size === 0)
        return true;
    const sourceLines = sourceText.split(/\r?\n/);
    let suspicious = 0;
    for (const line of lines.keys()) {
        const text = sourceLines[line - 1];
        if (text === undefined || text.trim() === '')
            suspicious++;
    }
    return suspicious / lines.size <= 0.1;
}
