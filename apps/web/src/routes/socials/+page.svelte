<script lang="ts">
  import { getVimState } from '$lib/vim.svelte';

  const socialLinks = [
    { href: 'https://instagram.com/pandoks_', icon: '/icons/instagram.svg', text: 'Instagram' },
    { href: 'https://tiktok.com/@pandoks_', icon: '/icons/tiktok.svg', text: 'TikTok' },
    { href: 'https://github.com/pandoks', icon: '/icons/github.svg', text: 'GitHub' },
    { href: 'https://x.com/pandoks_', icon: '/icons/x.svg', text: 'X' },
    { href: 'https://linkedin.com/in/pandoks', icon: '/icons/linkedin.svg', text: 'LinkedIn' }
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
    <img src={icon} alt={text} class="h-5 w-5" />
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
