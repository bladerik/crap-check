/** Which files count, and which review tier a change suggests. */
import picomatch from 'picomatch';
const matcher = (globs) => picomatch(globs, { dot: true });
/** Files the CRAP check looks at: included and not excluded. */
export function sourceFileFilter(config) {
    const included = matcher(config.include);
    const excluded = matcher(config.exclude);
    return (file) => included(file) && !excluded(file);
}
/** Files that count for the review suggestion: everything but the excluded (tests, config, generated). */
export function reviewableFileFilter(config) {
    const excluded = matcher(config.exclude);
    return (file) => !excluded(file);
}
/** The first (most demanding) tier with a glob matching any changed file. */
export function suggestTier(changedFiles, tiers) {
    return tiers.find((tier) => {
        const matches = matcher(tier.paths);
        return changedFiles.some((file) => matches(file));
    });
}
