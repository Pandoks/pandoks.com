<script lang="ts">
  import { dev } from '$app/environment';

  const { data } = $props();
</script>

<div
  class="scrollbar-thin font-garamond max-w-[clamp(50vw,50vw,100vw)] list-inside list-disc overflow-y-auto pb-[50vh]"
>
  {#each data.blocks as block}
    {@render blockRender(block)}
    {@render blockRender(block)}
  {/each}
</div>

{#snippet blockRender(block: any)}
  {#if block.type === 'heading_1'}
    <h1 class="text-2xl font-bold">{block.text}</h1>
  {:else if block.type === 'heading_2'}
    <h2 class="text-xl font-bold">{block.text}</h2>
  {:else if block.type === 'heading_3'}
    <h3 class="text-lg font-bold">{block.text}</h3>
  {:else if block.type === 'paragraph'}
    <p>{block.text}</p>
  {:else if block.type === 'link'}
    <div class="font-medium hover:cursor-pointer hover:underline">
      <a href={block.href} target="_blank">{block.text}</a>
    </div>
  {:else if block.type === 'image'}
    {#if dev}
      <img class="mx-auto" src={block.url} alt="blog description" />
    {:else}
      <enhanced:img class="mx-auto" src={block.url} alt="blog description" />
    {/if}
  {/if}
{/snippet}
