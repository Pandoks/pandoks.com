import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import globals from 'globals';

const gitignorePath = fileURLToPath(new URL('.gitignore', import.meta.url));

export default defineConfig([
  includeIgnoreFile(gitignorePath),
  { ignores: ['sst.config.ts'] },

  // GLOBAL RULES
  ...tseslint.configs.recommended,
  {
    plugins: { unicorn },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      'unicorn/prevent-abbreviations': [
        'error',
        {
          checkFilenames: false,
          replacements: {
            el: { element: true },
            els: { elements: true },
            ch: { char: true },
            cls: { classList: true },
            cp: { codepoint: true },
            cb: { callback: true },
            idx: { index: true },
            tmp: { temp: true },
            res: { response: true, result: true },
            req: { request: true },
            err: { error: true },
            args: false,
            props: false,
            ref: false,
            refs: false,
            params: false,
            env: false,
            db: false,
            fn: false,
            dev: false,
            prod: false,
            i: false,
            j: false,
            k: false,
            n: false,
            e: false
          },
          allowList: {
            Props: true,
            vps: true,
            cli: true,
            ssh: true,
            tls: true,
            tcp: true,
            udp: true,
            sql: true,
            url: true,
            uri: true,
            api: true,
            auth: true,
            pkg: true,
            src: true,
            dest: true
          }
        }
      ],
      'unicorn/no-array-for-each': 'error',
      'unicorn/no-for-loop': 'error',

      curly: ['error', 'multi-line'],
      'no-else-return': 'error',
      eqeqeq: ['error', 'smart'],

      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/consistent-indexed-object-style': ['error', 'record'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],

      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'default',
          format: ['camelCase'],
          leadingUnderscore: 'allowDouble',
          trailingUnderscore: 'allowDouble'
        },
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allowSingleOrDouble',
          trailingUnderscore: 'allowDouble'
        },
        {
          selector: 'parameter',
          format: ['camelCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow'
        },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['PascalCase'] },
        { selector: 'import', format: null },
        { selector: 'objectLiteralProperty', format: null },
        { selector: 'typeProperty', format: null }
      ]
    }
  },

  // SVELTE RULES
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte']
      }
    }
  },
  {
    files: ['**/*.svelte'],
    rules: {
      'prefer-const': 'off',
      'svelte/prefer-const': 'error'
    }
  },
  {
    files: ['packages/svelte/src/lib/components/ui/**'],
    rules: {
      'svelte/no-navigation-without-resolve': 'off'
    }
  },
  {
    files: ['apps/web/**/*.svelte'],
    rules: {
      'svelte/no-at-html-tags': 'off',
      'svelte/require-each-key': 'off'
    }
  },

  // TEST RULES
  {
    files: ['**/*.{test,spec}.ts', '**/*.svelte.{test,spec}.ts'],
    rules: {
      'unicorn/prevent-abbreviations': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/naming-convention': 'off'
    }
  }
]);
