// Flat ESLint config for the Whale web UI TypeScript sources.
//
// Focus: security + correctness on the *source* in src/. The built artifacts in
// ../web are generated (bundled/minified) and are NOT linted. Type-level checks
// are owned by `tsc --noEmit` (tsconfig has strict:true); ESLint here adds the
// security lens (eslint-plugin-security) plus baseline JS correctness rules.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';

export default tseslint.config(
  { ignores: ['../web/**', 'node_modules/**', 'build.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
    },
    rules: {
      // `_` is the intentional "unused on purpose" marker (mostly `catch (_)`).
      // Ignoring it is standard rule configuration, not a rule relaxation.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Security-relevant hardening on top of the plugin defaults.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      // The UI renders remote-derived strings (titles, filenames, URLs);
      // assigning untrusted data to innerHTML is the main XSS sink to catch.
      'no-restricted-properties': [
        'error',
        { object: 'document', property: 'write', message: 'document.write is an XSS/perf hazard.' },
      ],
    },
  },
);
