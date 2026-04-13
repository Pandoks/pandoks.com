<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { goto, preloadData } from '$app/navigation';
  import { onMount } from 'svelte';
  import { setVimState } from '$lib/vim.svelte';

  let { children } = $props();

  onMount(() => {
    if (!('requestIdleCallback' in window)) return;

    const allRoutes: string[] = (window as any).__ALL_ROUTES ?? [];
    requestIdleCallback(() => {
      for (const route of allRoutes) {
        preloadData(route);
      }
    });
  });

  const navLinks = [
    { href: '/', text: 'Jason Kwok' },
    { href: '/socials', text: 'Socials' },
    { href: '/work', text: 'Work' },
    { href: '/blog', text: 'Blog' }
  ];

  let activeNavIndex: number | undefined = $state();
  const vimState = setVimState()
    .setInitNavState(() => {
      activeNavIndex = activeNavIndex === undefined ? 0 : activeNavIndex;
    })
    .setResetNavState(() => {
      activeNavIndex = undefined;
    });
  vimState.setNavHandler((e: KeyboardEvent) => {
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
          vimState.clearBody();
          goto(navLinks[activeNavIndex].href);
        }
        return;
    }
  });
</script>

<nav class="bg-background fixed flex w-full gap-2 rounded-br-xs p-2 text-sm xl:w-auto">
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
    data-sveltekit-preload-data="hover"
    {href}
    class={`${page.url.pathname === href ? 'underline' : 'hover:underline'} ${activeNavIndex === index && vimState.active === 'nav' ? 'bg-highlight' : ''}`}
  >
    {text}
  </a>
{/snippet}
