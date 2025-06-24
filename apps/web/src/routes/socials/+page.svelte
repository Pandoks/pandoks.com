<script lang="ts">
</script>

<div class="-mt-14 pl-[clamp(0rem,1.2vw,1rem)] lg:mx-auto lg:pl-0">
  <div class="grid grid-cols-4 gap-4 md:grid-cols-5">
    {@render socialLink('https://instagram.com/pandoks_', '/icons/instagram.svg', 'Instagram')}
    {@render socialLink('https://tiktok.com/@pandoks_', '/icons/tiktok.svg', 'TikTok')}
    {@render socialLink('https://x.com/pandoks_', '/icons/x.svg', 'X')}
    {@render socialLink('https://github.com/pandoks', '/icons/github.svg', 'GitHub')}
    {@render socialLink('https://linkedin.com/in/pandoks', '/icons/linkedin.svg', 'LinkedIn')}
  </div>
</div>

{#snippet socialLink(href: string, icon: string, text: string)}
  <a {href} target="_blank" class="flex flex-row items-center gap-1 px-2 hover:bg-gray-100">
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
