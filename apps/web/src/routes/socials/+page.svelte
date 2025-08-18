<script lang="ts">
  import { getVimState } from '$lib/vim.svelte';
  import instagram from '$lib/icons/instagram.svg?raw';
  import tiktok from '$lib/icons/tiktok.svg?raw';
  import github from '$lib/icons/github.svg?raw';
  import x from '$lib/icons/x.svg?raw';
  import linkedin from '$lib/icons/linkedin.svg?raw';

  const socialLinks = [
    { href: 'https://instagram.com/pandoks_', icon: instagram, text: 'Instagram' },
    { href: 'https://tiktok.com/@pandoks_', icon: tiktok, text: 'TikTok' },
    { href: 'https://github.com/pandoks', icon: github, text: 'GitHub' },
    { href: 'https://x.com/pandoks_', icon: x, text: 'X' },
    { href: 'https://linkedin.com/in/pandoks', icon: linkedin, text: 'LinkedIn' }
  ];

  let activeSocialIndex: number | undefined = $state();
  const vimState = getVimState()
    .setBodyHandler((e) => {
      switch (e.key) {
        case 'h':
          if (activeSocialIndex) {
            activeSocialIndex--;
            return;
          }

          activeSocialIndex = socialLinks.length - 1;
          return;
        case 'l':
          if (activeSocialIndex === socialLinks.length - 1 || activeSocialIndex === undefined) {
            activeSocialIndex = 0;
            return;
          }

          activeSocialIndex++;
          return;
        case 'Enter':
          if (activeSocialIndex !== undefined) {
            window.open(socialLinks[activeSocialIndex].href, '_blank');
          }
          return;
      }
    })
    .setInitBodyState(() => {
      activeSocialIndex = activeSocialIndex === undefined ? 0 : activeSocialIndex;
    })
    .setResetBodyState(() => {
      activeSocialIndex = undefined;
    });
</script>

<div class="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5">
  {#each socialLinks as { href, icon, text }, index}
    {@render socialLink(href, icon, text, index)}
  {/each}
</div>

{#snippet socialLink(href: string, icon: string, text: string, index: number)}
  <a
    {href}
    target="_blank"
    class={`${activeSocialIndex === index && vimState.active === 'body' ? 'bg-highlight' : 'hover:bg-highlight'} flex flex-row items-center gap-1 px-2`}
  >
    <span class="h-5 w-5">{@html icon}</span>
    {text}
  </a>
{/snippet}

<svelte:head>
  <title>Pandoks Socials</title>
  <meta name="description" content="The socials for Jason Kwok" />
  <meta property="og:title" content="Jason Kwok's Socials (Pandoks_'s Socials)" />
  <meta
    property="og:description"
    content="Jason Kwok's social links which are mostly under the username Pandoks"
  />
</svelte:head>
