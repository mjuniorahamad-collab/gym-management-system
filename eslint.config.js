import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

export default [
  {
    // `functions` was previously ignored wholesale, which left the trusted
    // projection writer — the most security-sensitive code in the repository —
    // entirely unlinted. Hand-written Functions code is now linted; only its
    // dependencies and the generated bundle are excluded.
    //
    // `.kilo` / `.kilocode` are agent tool worktrees, not part of this project.
    // They are untracked and hidden from `git status` by .git/info/exclude, so
    // without this entry `eslint .` walks into a nested worktree containing its
    // own copy of functions/ and reports errors for code this repository does
    // not own. Ignoring them suppresses nothing in project source.
    ignores: [
      'dist',
      'node_modules',
      'coverage',
      'functions/node_modules',
      'functions/vendor',
      '.kilo',
      '.kilocode',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  {
    // Cloud Functions run in Node, not a browser. `functions/` used to be ignored
    // outright, so its globals were never declared; giving it its own block keeps
    // the browser globals above from masking genuinely Node-only code.
    files: ['functions/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // Operator scripts run in Node via `npx vite-node`, not in the browser.
    // The block above only matches .js/.jsx, so .mjs scripts would otherwise be
    // linted with no globals declared at all and report every `console` and
    // `process` use as undefined.
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  prettier,
]
