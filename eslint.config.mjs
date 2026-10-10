import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/release/**', 'spike/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // packages/core must stay free of Electron, Node OS modules and the network (AGENTS.md rule 1).
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'electron/*'], message: 'core must not import Electron.' },
            {
              group: ['node:*', 'fs', 'os', 'path', 'child_process', 'net', 'http', 'https'],
              message: 'core must not import Node OS modules.',
            },
          ],
        },
      ],
    },
  },
  {
    // OS checks belong in apps/desktop/src/platform only (AGENTS.md rule 2).
    files: ['**/*.ts'],
    ignores: ['apps/desktop/src/platform/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'platform', message: 'Put OS-specific code in apps/desktop/src/platform/.' },
      ],
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.ts', 'apps/desktop/src/preload/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
