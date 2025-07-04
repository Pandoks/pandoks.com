<script lang="ts">
  import { page } from '$app/state';
  import '../app.css';

  let { children } = $props();
  const pageSlug = $derived(new URL(page.url).pathname);
</script>

<nav class="font-inter bg-background fixed flex gap-2 rounded-br-xs p-2 text-sm">
  {@render navLink('/', 'Jason Kwok')}
  {@render navLink('/socials', 'Socials')}
  {@render navLink('/work', 'Work')}
  {@render navLink('/blog', 'Blog')}
</nav>

<div class="flex min-h-dvh items-center justify-center">
  <div class="pt-9 pb-12">
    {@render children()}
  </div>
</div>

{#snippet navLink(href: string, text: string)}
  <a
    data-sveltekit-preload-code="eager"
    {href}
    class={pageSlug === href ? 'underline' : 'hover:underline'}>{text}</a
  >
{/snippet}
