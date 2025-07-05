<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { setVimState } from '$lib/vim.svelte';

  let { children } = $props();
  const pageSlug = $derived(new URL(page.url).pathname);

  const navLinks = [
    { href: '/', text: 'Jason Kwok' },
    { href: '/socials', text: 'Socials' },
    { href: '/work', text: 'Work' },
    { href: '/blog', text: 'Blog' }
  ];

  let activeNavIndex: number | undefined = $state();
  setVimState()
    .setNavHandler((e) => {
      switch (e.key) {
        case 'h':
          if (activeNavIndex) {
            activeNavIndex--;
            return;
          }

          activeNavIndex = navLinks.length - 1;
          return;
        case 'l':
          if (activeNavIndex === navLinks.length - 1 || activeNavIndex === undefined) {
            activeNavIndex = 0;
            return;
          }

          activeNavIndex++;
          return;
        case 'Enter':
          if (activeNavIndex !== undefined) {
            goto(navLinks[activeNavIndex].href);
          }
          return;
      }
    })
    .setInitNavState(() => {
      activeNavIndex = 0;
    })
    .setResetNavState(() => {
      activeNavIndex = undefined;
    });
</script>

<nav class="font-inter bg-background fixed flex w-full gap-2 rounded-br-xs p-2 text-sm xl:w-auto">
  {#each navLinks as { href, text }, index}
    {@render navLink(href, text, index)}
  {/each}
</nav>

<div class="flex min-h-dvh items-center justify-center">
  <div class="pt-9 pb-12">
    {@render children()}
  </div>
</div>

{#snippet navLink(href: string, text: string, index: number)}
  <a
    data-sveltekit-preload-code="eager"
    {href}
    class={`${pageSlug === href ? 'underline' : 'hover:underline'} ${activeNavIndex === index ? 'bg-highlight' : ''}`}
  >
    {text}
  </a>
{/snippet}
