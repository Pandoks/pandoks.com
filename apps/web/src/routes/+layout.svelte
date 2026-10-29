<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { setVimState } from '#lib/vim.svelte.js';
  import { FONTS } from '#lib/fonts.js';
  import type { LayoutProps } from './$types';

  const { children }: LayoutProps = $props();

  onMount(() => {
    for (const [key, { file, family, weight, style }] of Object.entries(FONTS)) {
      void new FontFace(family, `url(/fonts/${file})`, { weight, style }).load().then(() => {
        document.querySelector(`style[data-critical-font="${key}"]`)?.remove();
      });
    }
  });

  const navLinks = [
    { path: '/', text: 'Jason Kwok' } as const,
    { path: '/socials', text: 'Socials' } as const,
    { path: '/work', text: 'Work' } as const,
    ...(__HAS_POSTS__ ? [{ path: '/blog', text: 'Blog' } as const] : [])
  ];

  // TODO: real addresses
  const wallets = [
    { ticker: 'xmr', address: 'XMR_ADDRESS_STUB' },
    { ticker: 'btc', address: 'BTC_ADDRESS_STUB' }
  ];
  let yankedTicker: string | undefined = $state();
  let yankTimeout: ReturnType<typeof setTimeout> | undefined;

  async function yankAddress(ticker: string, address: string) {
    await navigator.clipboard.writeText(address);
    yankedTicker = ticker;
    clearTimeout(yankTimeout);
    yankTimeout = setTimeout(() => {
      yankedTicker = undefined;
    }, 1000);
  }

  function moveSpotlight(event: PointerEvent & { currentTarget: HTMLButtonElement }) {
    event.currentTarget.style.setProperty('--spotlight-x', `${event.offsetX}px`);
    event.currentTarget.style.setProperty('--spotlight-y', `${event.offsetY}px`);
  }

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
          const link = navLinks[activeNavIndex];
          if (link) {
            vimState.clearBody();
            void goto(resolve(link.path));
          }
        }
        return;
    }
  });
</script>

<nav class="bg-background fixed flex w-full gap-2 rounded-br-xs p-2 text-sm xl:w-auto">
  {#each navLinks as { path, text }, index}
    {@render navLink(path, text, index)}
  {/each}
</nav>

<div class="flex min-h-dvh flex-col items-center">
  <div class="my-auto pt-9 pb-12">
    {@render children()}
  </div>

  <div class="flex flex-col items-start self-start p-2 font-mono text-xs">
    {#each wallets as { ticker, address }}
      <div class="flex gap-2">
        <button
          type="button"
          onclick={() => void yankAddress(ticker, address)}
          onkeypress={(event) => event.key === 'Enter' && event.stopPropagation()}
          onmousedown={(event) => event.preventDefault()}
          onpointermove={moveSpotlight}
          class={`cursor-pointer from-neutral-300 bg-clip-text text-left break-all transition-colors forced-color-adjust-none select-none hover:bg-radial-[circle_2.5rem_at_var(--spotlight-x)_var(--spotlight-y)] ${yankedTicker === ticker ? 'text-foreground duration-0 forced-colors:text-[CanvasText]' : 'text-transparent duration-1000 focus-visible:text-neutral-300 forced-colors:focus-visible:text-[CanvasText]'}`}
        >
          {ticker}
          {address}
        </button>
        <span
          aria-hidden="true"
          class={`text-muted-foreground shrink-0 transition-opacity select-none ${yankedTicker === ticker ? 'duration-0' : 'opacity-0 duration-1000'}`}
          >copied</span
        >
      </div>
    {/each}
  </div>
</div>

{#snippet navLink(path: (typeof navLinks)[number]['path'], text: string, index: number)}
  {@const href = resolve(path)}
  <a
    data-sveltekit-preload-data="hover"
    {href}
    class={`${page.url.pathname === href ? 'underline' : 'hover:underline'} ${activeNavIndex === index && vimState.active === 'nav' ? 'bg-highlight' : ''}`}
  >
    {text}
  </a>
{/snippet}
