import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // React hooks rules
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Relax some TS rules for migration
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Allow empty interfaces during migration
      '@typescript-eslint/no-empty-interface': 'off',
    },
  },
  {
    // Serverless functions + build scripts: plain Node ESM that also embeds
    // browser-context functions (page.evaluate). Give them Node + browser
    // globals so no-undef actually catches a genuinely undefined binding
    // (e.g. a deleted top-level const) instead of drowning in false positives.
    files: ['api/**/*.js', 'scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-undef': 'error',
      // Intentional in these files: Amazon sharedString index sparse arrays and
      // escaped slashes in tag/URL regexes. Not the bug class this guard targets.
      'no-sparse-arrays': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.config.*', 'legacy.html'],
  }
);
