<script lang="ts">
  import { page } from '$app/state';

  let { children } = $props();
  const pageSlug = $derived(new URL(page.url).pathname);
</script>

<main class="relative">
  {@render children()}
</main>

<nav class="font-inter fixed bottom-[20vh] flex justify-center gap-2 text-sm">
  {@render navLink('/', 'Jason Kwok')}
  {@render navLink('/socials', 'Socials')}
  {@render navLink('/work', 'Work')}
  {@render navLink('/blog', 'Blog')}
</nav>

{#snippet navLink(href: string, text: string)}
  <a
    data-sveltekit-preload-code="eager"
    {href}
    class={pageSlug === href ? 'underline' : 'hover:underline'}>{text}</a
  >
{/snippet}
