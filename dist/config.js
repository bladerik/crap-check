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
export function loadConfig(repoRoot, file = CONFIG_FILE) {
    const configPath = path.resolve(repoRoot, file);
    const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
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
