import type { Handle } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { injectCriticalFonts } from '#lib/server/critical-fonts.js';
import { injectPrefetchHints } from '#lib/server/module-preloads.js';

export const handle: Handle = async ({ event, resolve }) => {
  let htmlChunk = '';
  return resolve(event, {
    transformPageChunk: async ({ html, done }) => {
      if (!building) return html;

      htmlChunk += html;
      if (!done) return '';

      const finalHtml = await injectCriticalFonts(htmlChunk);
      return injectPrefetchHints(finalHtml);
    }
  });
};
