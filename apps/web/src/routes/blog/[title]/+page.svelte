<script lang="ts">
  import { dev } from '$app/environment';
  import { hljs } from '$lib/highlight';

  const { data } = $props();
</script>

<div
  class="font-garamond max-w-screen px-3 sm:max-w-[75vw] sm:px-0 xl:max-w-[60vw] 2xl:max-w-[clamp(0rem,60vw,75rem)]"
>
  <h1 class="text-xl font-black">{data.title}</h1>
  <p class="mb-5 text-sm">{data.createdTime}</p>

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
    <p class="mb-5">{block.text}</p>
  {:else if block.type === 'link'}
    <div class="underline decoration-dashed hover:cursor-pointer hover:decoration-solid">
      <a href={block.href} target="_blank">{block.text}</a>
    </div>
  {:else if block.type === 'break'}
    <br />
  {:else if block.type === 'image'}
    {#if dev}
      <img class="mx-auto mb-5 rounded-xs" src={block.url} alt="A thousand words" />
    {:else}
      <enhanced:img class="mx-auto mb-5 rounded-xs" src={block.url} alt="A thousand words" />
    {/if}
  {:else if block.type === 'code'}
    <!-- NOTE: this NEEDS to be formatted weirdly because of the pre tag -->
    <pre
      class="bg-highlight scrollbar-thin mb-5 overflow-x-auto rounded-xs p-4"
      style="scrollbar-width: thin;"><code class="font-mono text-xs lg:text-sm"
        >{@html hljs.highlight(block.code, { language: block.language }).value}</code
      ></pre>
  {/if}
{/snippet}
