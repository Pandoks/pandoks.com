<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { goto, preloadData, afterNavigate } from '$app/navigation';
  import { onMount } from 'svelte';
  import { setVimState } from '$lib/vim.svelte';

  let { children } = $props();

  const preloadedRoutes = new Set<string>();

  function discoverAndPreload() {
    const idle =
      'requestIdleCallback' in window ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 200);
    idle(() => {
      const links = document.querySelectorAll<HTMLAnchorElement>('a[href]');
      for (const link of links) {
        try {
          const url = new URL(link.href, window.location.origin);
          if (url.origin !== window.location.origin) continue;
          if (preloadedRoutes.has(url.pathname)) continue;
          preloadedRoutes.add(url.pathname);
          preloadData(url.pathname);
        } catch {
          // skip invalid URLs
        }
      }
    });
  }

  onMount(() => {
    // Preload full variable fonts so they're cached for after critical fonts
    for (const file of ['Inter', 'Inter-Italic', 'EBGaramond', 'EBGaramond-Italic']) {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'font';
      link.type = 'font/woff2';
      link.crossOrigin = 'anonymous';
      link.href = `/fonts/${file}.woff2`;
      document.head.appendChild(link);
    }

    // BFS level 1: preload all internal links on the current page
    discoverAndPreload();
  });

  // BFS level 2+: after each navigation, preload any new links on the new page
  afterNavigate(() => {
    discoverAndPreload();
  });

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
    data-sveltekit-preload-data="hover"
    {href}
    class={`${page.url.pathname === href ? 'underline' : 'hover:underline'} ${activeNavIndex === index && vimState.active === 'nav' ? 'bg-highlight' : ''}`}
  >
    {text}
  </a>
{/snippet}
