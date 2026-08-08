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
      // Agent worktrees. A `git worktree` placed inside the repo is a second, complete
      // checkout of it — so `eslint .` walks into it and reports every finding twice, against
      // file paths that are not the ones you are editing. Git itself already keeps a
      // registered worktree out of `status`; this is the same courtesy for the linter.
      //
      // Only the linter needs it: vitest's `packages/*/src/**` and the coverage `include` are
      // root-relative with a single-segment wildcard, so a nested checkout cannot match them.
      '.claude/**',
      // Not worth a program of its own; nothing here is shipped.
      'eslint.config.js',
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
        projectService: { allowDefaultProject: ['*.js', 'scripts/*.mjs'] },
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
    files: ['packages/virtual-anchor/src/react/**/*.{ts,tsx}', 'apps/demo/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  {
    // The debug entry is a developer tool, and printing its conclusion is its job.
    //
    // Everywhere else in this package `console.log` is rightly an error: a library that
    // narrates itself in a consumer's console is a nuisence they cannot turn off. Here the
    // output *is* the product, it only exists in a build that opted into instrumentation, and
    // it is reached only by importing `virtual-anchor/debug` deliberately. `warn` would be the
    // available alternative and is the wrong semantics — a gesture with no suspect is not a
    // warning, and if every conclusion were one, the ones that matter would stop standing out.
    files: ['packages/virtual-anchor/src/debug/**/*.ts'],
    rules: {
      'no-console': 'off',
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
      // Test doubles are mostly no-op members standing in for a real API.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions', 'methods'] }],
    },
  },

  {
    // Every scroll write must go through the momentum gate.
    //
    // Structural, because the alternative failed: the guard against writing
    // `scrollTop` during an iOS fling lived inside the scroller, and `engine.publish`
    // acquired two writes of its own that simply did not consult it — for two
    // releases, invisibly, because nothing on the iOS path was tested above the
    // scroller. A grep-shaped rule is not elegant, but it is the only thing that
    // makes a *third* such site fail the build rather than ship.
    //
    // Scoped to the whole library, not to the two files that already write. The bug
    // it exists for was `engine.ts` *acquiring* writes that `scroller.ts`'s guard did
    // not cover, so a rule listing exactly those two files cannot catch the next one —
    // a write added to `resizer.ts`, or to a module that does not exist yet, would be
    // unrestricted. `viewport.ts` is where `setScrollOffset` is defined and the tests
    // are where it is faked, so both are exempted below.
    files: ['packages/virtual-anchor/src/**/*.{ts,tsx}'],
    ignores: [
      'packages/virtual-anchor/src/viewport.ts',
      'packages/virtual-anchor/src/**/*.test.*',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='setScrollOffset']",
          message:
            'Route scroll writes through the momentum gate: check writeGate.canWrite() first, or defer. See issue #26.',
        },
      ],
    },
  },

  {
    files: ['scripts/**/*.mjs'],
    rules: {
      // Release scripts are command-line tools: reporting what they did on stdout is the
      // point, and a packaging check that said nothing would be useless.
      'no-console': 'off',
      // `JSON.parse` is `any`, and the file being parsed here is this repo's own manifest.
      // The shape is documented in JSDoc where it is read; a runtime validator would add
      // ceremony rather than safety, since the script's job is to fail loudly either way.
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  {
    files: ['packages/virtual-anchor/src/react/**/*.{ts,tsx}'],
    rules: {
      // These two are React-Compiler-oriented, and this library deliberately hands ref
      // callbacks and a `{ current }` box across its own hook boundary — the item ref
      // registry lives on the engine precisely so it is stable across renders. The rules
      // cannot verify that a callback returned from a hook is a legitimate ref callback,
      // so what remains after fixing every genuine instance is the seam itself.
      //
      // Left ON for the demo, which is ordinary consumer code — where they caught two
      // real render-time ref writes.
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
)
