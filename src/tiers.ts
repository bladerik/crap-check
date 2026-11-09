/** Which files count, and which review tier a change suggests. */
import picomatch from 'picomatch';
import type { Config, ReviewTier } from './config.js';

const matcher = (globs: string[]) => picomatch(globs, { dot: true });

/** Files the CRAP check looks at: included and not excluded. */
export function sourceFileFilter(config: Pick<Config, 'include' | 'exclude'>): (file: string) => boolean {
	const included = matcher(config.include);
	const excluded = matcher(config.exclude);
	return (file) => included(file) && !excluded(file);
}

/** Files that count for the review suggestion: everything but the excluded (tests, config, generated). */
export function reviewableFileFilter(config: Pick<Config, 'exclude'>): (file: string) => boolean {
	const excluded = matcher(config.exclude);
	return (file) => !excluded(file);
}

/** The first (most demanding) tier with a glob matching any changed file. */
export function suggestTier(changedFiles: string[], tiers: ReviewTier[]): ReviewTier | undefined {
	return tiers.find((tier) => {
		const matches = matcher(tier.paths);
		return changedFiles.some((file) => matches(file));
	});
}
