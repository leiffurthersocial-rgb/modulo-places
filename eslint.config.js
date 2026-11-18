import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      '.asset-cache',
      'playwright-report',
      'test-results',
      'public',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  {
    // Classroom simulation core must stay pure TypeScript: deterministic, headless-runnable.
    files: ['src/classroom/sim/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['three', 'three/*', '**/render/**', '**/ui/**', '**/audio/**', '**/input/**'],
        },
      ],
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'performance',
        'requestAnimationFrame',
        'localStorage',
        { name: 'Math.random', message: 'Use sim/rng.ts' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded Rng (sim/rng.ts).' },
        { object: 'Date', property: 'now', message: 'Use the SimClock.' },
      ],
    },
  },
);
