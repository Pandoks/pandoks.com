<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { setVimState } from '$lib/vim.svelte';
  import { FONTS } from '$lib/fonts';

  const { children } = $props();

  onMount(() => {
    for (const [key, { file, family, weight, style }] of Object.entries(FONTS)) {
      new FontFace(family, `url(/fonts/${file})`, { weight, style }).load().then(() => {
        document.querySelector(`style[data-critical-font="${key}"]`)?.remove();
      });
    }
  });

  const navLinks = [
    { path: '/', text: 'Jason Kwok' },
    { path: '/socials', text: 'Socials' },
    { path: '/work', text: 'Work' },
    ...(__HAS_POSTS__ ? [{ path: '/blog', text: 'Blog' }] : [])
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
          const link = navLinks[activeNavIndex];
          if (link) {
            vimState.clearBody();
            goto(resolve(link.path));
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

<div class="flex min-h-dvh items-center justify-center">
  <div class="pt-9 pb-12">
    {@render children()}
  </div>
</div>

{#snippet navLink(path: string, text: string, index: number)}
  {@const href = resolve(path)}
  <a
    data-sveltekit-preload-data="hover"
    {href}
    class={`${page.url.pathname === href ? 'underline' : 'hover:underline'} ${activeNavIndex === index && vimState.active === 'nav' ? 'bg-highlight' : ''}`}
  >
    {text}
  </a>
{/snippet}
