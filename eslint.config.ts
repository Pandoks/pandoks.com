import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
// @ts-expect-error eslint-plugin-expo ships no type declarations
import expoPlugin from 'eslint-plugin-expo';
import reactHooks from 'eslint-plugin-react-hooks';
import type { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

const expo = expoPlugin as ESLint.Plugin;
import unicorn from 'eslint-plugin-unicorn';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import globals from 'globals';

const gitignorePath = fileURLToPath(new URL('.gitignore', import.meta.url));

export default defineConfig([
  includeIgnoreFile(gitignorePath),
  { ignores: ['sst.config.ts', '**/sst-env.d.ts', '**/.svelte-kit/'] },

  // GLOBAL RULES
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    plugins: { unicorn },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        extraFileExtensions: ['.svelte'],
        projectService: {
          allowDefaultProject: [
            '*/*/forge.config.ts',
            '*/*/svelte.config.js',
            '*/*/playwright.config.ts',
            '*/*/vitest-setup-client.ts',
            '*/*/vite.main.config.ts',
            '*/*/vite.preload.config.ts',
            '*/*/e2e/*.test.ts',
            '*/*/jest.config.js',
            'packages/*/*/jest.config.ts',
            'scripts/*/*.{js,ts}'
          ],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 25
        },
        tsconfigRootDir: import.meta.dirname
      }
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
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['PascalCase'] },
        { selector: 'import', format: null },
        { selector: 'objectLiteralProperty', format: null },
        { selector: 'typeProperty', format: null }
      ]
    }
  },

  // SVELTE RULES
  svelte.configs.recommended,
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
      'svelte/no-navigation-without-resolve': 'off',
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off'
    }
  },
  {
    files: ['**/vitest-setup-client.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off'
    }
  },
  {
    files: ['apps/desktop-template/electron/**'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off'
    }
  },
  {
    files: ['apps/web/**'],
    languageOptions: {
      globals: {
        __HAS_POSTS__: 'readonly',
        __BLOG_TITLES__: 'readonly',
        __HAS_HOME_PAGE_BLOG_POST__: 'readonly'
      }
    }
  },
  {
    files: ['apps/web/**/*.svelte'],
    rules: {
      'svelte/no-at-html-tags': 'off',
      'svelte/require-each-key': 'off'
    }
  },

  // REACT NATIVE RULES
  {
    files: ['apps/mobile-template/**', 'packages/react-native/**'],
    extends: [reactHooks.configs.flat.recommended],
    plugins: { expo },
    rules: {
      'expo/no-dynamic-env-var': 'error',
      'expo/no-env-var-destructuring': 'error',
      'expo/prefer-box-shadow': 'error',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } }
      ]
    }
  },

  // TEST RULES
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/*.svelte.{test,spec}.ts'],
    rules: {
      'unicorn/prevent-abbreviations': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/naming-convention': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/unbound-method': 'off'
    }
  }
]);
