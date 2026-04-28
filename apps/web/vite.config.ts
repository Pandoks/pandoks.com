import tailwindcss from '@tailwindcss/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { enhancedImages } from '@sveltejs/enhanced-img';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { define } from './vite/declarations';
import { hideBlogWhenEmpty } from './vite/plugins/hide-blog';

export default defineConfig({
  define,
  plugins: [
    hideBlogWhenEmpty(),
    tailwindcss(),
    enhancedImages(),
    sveltekit(),
    viteStaticCopy({
      // don't point to static directory, point to finished build directory (static -> / after build)
      targets: [{ src: '../../packages/svelte/static/fonts/*', dest: 'fonts' }]
    })
  ],
  envDir: '../..',
  server: {
    fs: {
      allow: ['../../']
    }
  },
  test: {
    projects: [
      {
        extends: './vite.config.ts',
        plugins: [svelteTesting()],
        test: {
          name: 'client',
          environment: 'jsdom',
          clearMocks: true,
          include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
          exclude: ['src/lib/server/**'],
          setupFiles: ['./vitest-setup-client.ts']
        }
      },
      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.{test,spec}.{js,ts}'],
          exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
        }
      }
    ]
  }
});
