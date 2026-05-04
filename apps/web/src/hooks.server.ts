import { building } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { injectCriticalFonts } from '$lib/server/critical-fonts';
import { injectPrefetchHints } from '$lib/server/module-preloads';

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
