/** `crap.config.json` at the repository root, with defaults for everything but the packages. */
import fs from 'node:fs';
import path from 'node:path';
export const CONFIG_FILE = 'crap.config.json';
export const DEFAULTS = {
    threshold: 30,
    base: 'origin/main',
    include: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/*.d.ts',
        '**/*.{test,spec}.*',
        '**/__tests__/**',
        '**/tests/**',
        '**/test/**',
        '**/_generated/**',
        '**/*.config.*'
    ],
    reviewTiers: []
};
/**
 * Reads the config. `readText` overrides where it comes from: with `--ref` it is the judged commit,
 * so an uncommitted config edit cannot change the verdict.
 */
export function loadConfig(repoRoot, file = CONFIG_FILE, readText) {
    const configPath = path.resolve(repoRoot, file);
    const text = readText ? readText(file) : fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : undefined;
    const raw = text === undefined ? {} : JSON.parse(text);
    const config = { ...DEFAULTS, packages: [{ root: '.', coverage: 'coverage/lcov.info' }], ...raw };
    if (raw.exclude && raw.excludeDefaults !== false)
        config.exclude = [...DEFAULTS.exclude, ...raw.exclude];
    if (!Array.isArray(config.packages) || config.packages.length === 0) {
        throw new Error(`${file}: "packages" must list at least one package`);
    }
    return config;
}
/** The package a repo-relative file belongs to: the one with the longest matching root. */
export function packageFor(config, file) {
    const normalized = (root) => (root === '.' || root === '' ? '' : `${root.replace(/\/+$/, '')}/`);
    return [...config.packages]
        .sort((a, b) => normalized(b.root).length - normalized(a.root).length)
        .find((pkg) => file.startsWith(normalized(pkg.root)));
}
