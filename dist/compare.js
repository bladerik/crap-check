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
/** Same name first; else an identical body elsewhere in the old file(s) means it only moved. */
export function matchBase(fn, base) {
    const byName = base.find((candidate) => candidate.name === fn.name);
    if (byName)
        return { kind: 'changed', base: byName };
    const byBody = base.find((candidate) => candidate.bodyHash === fn.bodyHash);
    if (byBody)
        return { kind: 'moved', base: byBody };
    return { kind: 'new' };
}
function judgeExisting(fn, base, threshold) {
    if (fn.crap <= threshold)
        return { status: 'ok' };
    if (base.crap !== undefined) {
        return fn.crap > base.crap + 0.05
            ? { status: 'fail', reason: `CRAP rose from ${base.crap.toFixed(1)} and is over ${threshold}` }
            : { status: 'warn', reason: `over ${threshold}, not worse than before` };
    }
    return fn.complexity > base.complexity
        ? { status: 'fail', reason: `complexity rose from ${base.complexity} and CRAP is over ${threshold}` }
        : { status: 'warn', reason: `over ${threshold}, complexity not higher (no baseline coverage)` };
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
