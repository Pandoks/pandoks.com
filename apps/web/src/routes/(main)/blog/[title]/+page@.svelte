<script lang="ts">
  import { dev } from '$app/environment';

  const { data } = $props();
</script>

<nav class="font-inter fixed bottom-[20vh] flex justify-center gap-2 text-sm">
  <a data-sveltekit-preload-code="eager" href="/blog" class="hover:underline">Back</a>
</nav>

<div class="scrollbar-thin ml-7 max-h-[40vh] list-inside list-disc overflow-y-auto pr-10">
  {#each data.blocks as block}
    {@render blockRender(block)}
  {/each}
</div>

{#snippet blockRender(block: any)}
  {#if block.type === 'heading_1'}
    <h1>{block.text}</h1>
  {:else if block.type === 'heading_2'}
    <h2>{block.text}</h2>
  {:else if block.type === 'heading_3'}
    <h3>{block.text}</h3>
  {:else if block.type === 'paragraph'}
    <p>{block.text}</p>
  {:else if block.type === 'link'}
    <a href={block.href} target="_blank">{block.text}</a>
  {:else if block.type === 'image'}
    {#if dev}
      <img src={block.url} alt="hi" />
    {:else}
      <enhanced:img src={block.url} alt="hi" />
    {/if}
  {/if}
{/snippet}
