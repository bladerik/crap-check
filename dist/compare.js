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
/** The name without its `#2` repeat label. */
export const stem = (name) => name.replace(/#\d+$/, '');
const tokens = (text) => new Set(text.split(/[^A-Za-z0-9_$]+/).filter(Boolean));
/** Share of distinct identifiers two bodies have in common (Jaccard), 0..1. */
export function similarity(a, b) {
    const left = tokens(a);
    const right = tokens(b);
    if (left.size === 0 && right.size === 0)
        return 1;
    let shared = 0;
    for (const token of left)
        if (right.has(token))
            shared++;
    return shared / (left.size + right.size - shared);
}
const countBy = (names) => {
    const counts = new Map();
    for (const name of names)
        counts.set(stem(name), (counts.get(stem(name)) ?? 0) + 1);
    return counts;
};
/**
 * Pairs the head functions of one file with their base versions (head index -> base index):
 * 1. an identical body under the same name stem;
 * 2. the same name, when that stem occurs equally often on both sides (nothing inserted or removed);
 * 3. the most similar body under the same stem, if at least half of its identifiers are shared.
 * Repeat labels (`#2`) shift when a same-named callback is inserted, so they never decide alone.
 */
export function pairFunctions(head, base) {
    const pairs = new Map();
    const used = new Set();
    const pair = (h, b) => (pairs.set(h, b), used.add(b));
    const free = (h) => base.map((_, b) => b).filter((b) => !used.has(b) && stem(base[b].name) === stem(head[h].name));
    head.forEach((fn, h) => {
        const same = free(h).find((b) => base[b].bodyHash === fn.bodyHash);
        if (same !== undefined)
            pair(h, same);
    });
    const headCounts = countBy(head.map((fn) => fn.name));
    const baseCounts = countBy(base.map((fn) => fn.name));
    head.forEach((fn, h) => {
        if (pairs.has(h) || headCounts.get(stem(fn.name)) !== baseCounts.get(stem(fn.name)))
            return;
        const byName = free(h).find((b) => base[b].name === fn.name);
        if (byName !== undefined)
            pair(h, byName);
    });
    head.forEach((fn, h) => {
        if (pairs.has(h))
            return;
        const scored = free(h).map((b) => ({ b, score: similarity(fn.bodyText, base[b].bodyText ?? '') }));
        const best = scored.sort((x, y) => y.score - x.score)[0];
        if (best && best.score >= 0.5)
            pair(h, best.b);
    });
    return pairs;
}
/** Why an old function over the threshold was let through, with what the baseline knew. */
function letThroughReason(fn, base, threshold) {
    if (base.crap !== undefined && base.crap <= threshold) {
        return `was CRAP ${base.crap.toFixed(1)} in the baseline: it lost coverage, or the related tests miss it`;
    }
    if (base.crap !== undefined && fn.crap > base.crap + 0.05) {
        return `not more complex; CRAP rose from ${base.crap.toFixed(1)} (lower coverage than the full-suite baseline)`;
    }
    return `over ${threshold} before too, not more complex`;
}
function judgeExisting(fn, base, threshold) {
    if (fn.crap <= threshold)
        return { status: 'ok' };
    return fn.complexity > base.complexity
        ? { status: 'fail', reason: `complexity rose from ${base.complexity} and CRAP is over ${threshold}` }
        : { status: 'warn', reason: letThroughReason(fn, base, threshold) };
}
export function judge(fn, match, threshold) {
    if (match.kind === 'new' || !match.base) {
        return fn.crap <= threshold
            ? { ...fn, kind: 'new', status: 'ok' }
            : { ...fn, kind: 'new', status: 'fail', reason: `new function over ${threshold}` };
    }
    return { ...fn, kind: match.kind, base: match.base, ...judgeExisting(fn, match.base, threshold) };
}
