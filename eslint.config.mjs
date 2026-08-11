import js from '@eslint/js'
import next from 'eslint-config-next'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      '.pglite/**',
      'supabase/migrations/**',
      // Installed ECC tooling, not this project's source.
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,
  {
    rules: {
      // Unused args are fine when prefixed — server action signatures require
      // a `_previous` parameter that is genuinely unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The FX balancing code narrows `fxGainLossAccountId` before asserting it.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
)
