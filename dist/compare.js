export const headKey = (file, name) => `${file}::${name}`;
const touches = (fn, lines) => {
    for (const line of lines)
        if (line >= fn.startLine && line <= fn.endLine)
            return true;
    return false;
};
/** Functions containing an added or modified line. Outer functions count too: their range changed. */
export function touchedFunctions(functions, addedLines) {
    return functions.filter((fn) => touches(fn, addedLines));
}
/**
 * Same name in the same file: changed. Otherwise an identical body whose original is gone at head
 * (renamed, or moved to another file): moved. A copy of a function that still exists is new.
 */
export function matchBase(fn, base) {
    const byName = base.sameFile.find((candidate) => candidate.name === fn.name);
    if (byName)
        return { kind: 'changed', base: byName };
    const moved = base.pool.find((candidate) => candidate.bodyHash === fn.bodyHash && !base.atHead.has(headKey(candidate.file, candidate.name)));
    return moved ? { kind: 'moved', base: moved } : { kind: 'new' };
}
function judgeExisting(fn, base, threshold) {
    if (fn.crap <= threshold)
        return { status: 'ok' };
    return fn.complexity > base.complexity
        ? { status: 'fail', reason: `complexity rose from ${base.complexity} and CRAP is over ${threshold}` }
        : { status: 'warn', reason: `over ${threshold}, not more complex than before` };
}
export function judge(fn, base, threshold) {
    const match = matchBase(fn, base);
    if (match.kind === 'new' || !match.base) {
        return fn.crap <= threshold
            ? { ...fn, kind: 'new', status: 'ok' }
            : { ...fn, kind: 'new', status: 'fail', reason: `new function over ${threshold}` };
    }
    return { ...fn, kind: match.kind, base: match.base, ...judgeExisting(fn, match.base, threshold) };
}
