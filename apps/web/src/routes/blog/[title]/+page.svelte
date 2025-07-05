<script lang="ts">
  import { dev } from '$app/environment';

  const { data } = $props();
</script>

<div class="font-garamond mx-3 sm:max-w-[75vw] xl:max-w-[60vw] 2xl:max-w-[clamp(0rem,60vw,75rem)]">
  <h1 class="text-xl font-black">{data.title}</h1>
  <p class="mb-3 text-sm">{data.createdTime}</p>

  {#each data.blocks as block}
    {@render blockRender(block)}
  {/each}
</div>

{#snippet blockRender(block: any)}
  {#if block.type === 'heading_1'}
    <h2 class="font-extrabold">{block.text}</h2>
  {:else if block.type === 'heading_2'}
    <h3 class="font-bold">{block.text}</h3>
  {:else if block.type === 'heading_3'}
    <h4 class="font-semibold">{block.text}</h4>
  {:else if block.type === 'paragraph'}
    <p class="mb-3">{block.text}</p>
  {:else if block.type === 'link'}
    <div class="underline decoration-dashed hover:cursor-pointer hover:decoration-solid">
      <a href={block.href} target="_blank">{block.text}</a>
    </div>
  {:else if block.type === 'image'}
    {#if dev}
      <img class="mx-auto mb-3 rounded-xs" src={block.url} alt="A thousand words" />
    {:else}
      <enhanced:img class="mx-auto mb-3 rounded-xs" src={block.url} alt="A thousand words" />
    {/if}
  {/if}
{/snippet}
