import { building } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { injectCriticalFonts } from '$lib/server/critical-fonts';
import { injectPrefetchHints } from '$lib/server/prefetch-hints';

export const handle: Handle = async ({ event, resolve }) => {
  return resolve(event, {
    transformPageChunk: async ({ html, done }) => {
      if (!done || !building) return html;
      let result = await injectCriticalFonts(html);
      result = injectPrefetchHints(result);
      return result;
    }
  });
};
