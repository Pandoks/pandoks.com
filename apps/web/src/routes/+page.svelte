<script lang="ts">
  import {
    garamondHomeCritical,
    garamondItalicHomeCritical
  } from '@lib/styles/critical-fonts';
</script>

<div class="font-garamond text-center text-lg">
  <p>
    Obssessed with the
    <a href="/blog/The-Human-Experience" class="italic hover:underline">Human Experience</a>
    .
  </p>
</div>

<svelte:head>
  {@html `<style data-critical-font>${garamondHomeCritical}${garamondItalicHomeCritical}</style>`}
  <title>Pandoks</title>
  <meta name="description" content="Home page talking about who Jason Kwok is" />
  <meta property="og:title" content="Jason Kwok (Pandoks_)" />
  <meta property="og:description" content="Home page talking about who Jason Kwok or Pandoks_ is" />
</svelte:head>
