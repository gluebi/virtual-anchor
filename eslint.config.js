import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/docs-api/**',
      '**/node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'spike/residual-carry.html',
    ],
  },

  js.configs.recommended,

  // Type-aware linting. Worth the slower runs here: the rules that matter most in
  // this codebase — floating promises, unnecessary conditions, deprecated APIs —
  // all need type information, and two of the four `eslint-disable` comments
  // already in the source reference type-aware rules.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // `tsconfig.tools.json` covers the configs, e2e specs and spike, so every
        // linted file belongs to a real program with `strictNullChecks` on. The
        // alternative — `allowDefaultProject` — gives them a program *without* it, and
        // four type-aware rules then report themselves as unusable once per file.
        projectService: { allowDefaultProject: ['*.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // The library is deliberately mutation-heavy in its hot paths (typed-array
      // Fenwick updates, in-place state objects), so a few strict-type-checked
      // rules fight the design rather than improving it.
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Positions and offsets are numbers; template-literal checks on them add
      // `String(...)` noise without catching anything real. Keep the check for
      // the genuinely ambiguous cases only.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      'no-console': ['error', { allow: ['warn', 'error'] }],
      // `() => {}` is the idiomatic no-op — null implementations, unsubscribe stubs,
      // test doubles. Flagging 31 of them teaches nothing.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
      // Unused args are useful documentation on interface implementations.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    files: ['packages/react/**/*.{ts,tsx}', 'apps/demo/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Tests and tooling: the strictest rules exist to protect production code, and
  // in tests they mostly obstruct constructing deliberately awkward inputs.
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.dom.test.ts',
      'e2e/**/*.ts',
      'spike/**/*.ts',
      '*.config.ts',
      'eslint.config.js',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
)
