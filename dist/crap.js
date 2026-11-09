/**
 * CRAP (Change Risk Anti-Patterns), by Alberto Savoia and Bob Evans:
 * complexity^2 * (1 - coverage)^3 + complexity. Low when code is simple or well tested.
 */
export function crapScore(complexity, coverage) {
    const uncovered = 1 - Math.min(1, Math.max(0, coverage));
    return complexity * complexity * uncovered ** 3 + complexity;
}
export const round1 = (value) => Math.round(value * 10) / 10;
