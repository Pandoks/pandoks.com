<script lang="ts">
  import { resolve } from '$app/paths';
</script>

<div class="font-garamond text-center text-lg">
  <p>
    Obssessed with the
    {#if __HAS_HOME_PAGE_BLOG_POST__}
      <a
        href={resolve('/blog/[title]', { title: 'the-human-experience' })}
        class="italic hover:underline">Human Experience</a
      >
    {:else}
      <span class="italic">Human Experience</span>
    {/if}
    .
  </p>
</div>

<svelte:head>
  <title>Pandoks</title>
  <meta name="description" content="Home page talking about who Jason Kwok is" />
  <meta property="og:title" content="Jason Kwok (Pandoks_)" />
  <meta property="og:description" content="Home page talking about who Jason Kwok or Pandoks_ is" />
</svelte:head>
