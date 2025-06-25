<script lang="ts">
  import { page } from '$app/state';
  import '../app.css';

  let { children } = $props();
</script>

<nav
  class="font-inter fixed bottom-40 left-1/2 flex w-full -translate-x-1/2 flex-row justify-center gap-2 text-sm"
>
  {@render navLink('/', 'Jason Kwok')}
  {@render navLink('/socials', 'Socials')}
  {@render navLink('/work', 'Work')}
  <a
    data-sveltekit-preload-code="eager"
    href="/blog"
    class={page.route.id === '/blog'
      ? 'underline decoration-dashed'
      : 'hover:underline hover:decoration-dashed'}>Blog</a
  >
</nav>

<div class="flex h-dvh items-center justify-center">
  {@render children()}
</div>

{#snippet navLink(href: string, text: string)}
  <a
    data-sveltekit-preload-code="eager"
    {href}
    class={page.route.id === href ? 'underline' : 'hover:underline'}>{text}</a
  >
{/snippet}
