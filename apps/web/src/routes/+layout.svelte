<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { goto, preloadData } from '$app/navigation';
  import { onMount } from 'svelte';
  import { setVimState } from '$lib/vim.svelte';

  let { children } = $props();

  const navLinks = [
    { href: '/', text: 'Jason Kwok' },
    { href: '/socials', text: 'Socials' },
    { href: '/work', text: 'Work' },
    { href: '/blog', text: 'Blog' }
  ];

  onMount(() => {
    // Preload full variable fonts so they're cached for after critical fonts
    const fontUrls = [
      '/fonts/Inter.woff2',
      '/fonts/Inter-Italic.woff2',
      '/fonts/EBGaramond.woff2',
      '/fonts/EBGaramond-Italic.woff2'
    ];
    for (const url of fontUrls) {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'font';
      link.type = 'font/woff2';
      link.crossOrigin = 'anonymous';
      link.href = url;
      document.head.appendChild(link);
    }

    // Preload all pages when browser is idle so navigation is instant
    const idle = 'requestIdleCallback' in window ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 200);
    idle(() => {
      for (const { href } of navLinks) {
        preloadData(href);
      }
    });
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
