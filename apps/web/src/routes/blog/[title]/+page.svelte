<script lang="ts">
  import type { PageData } from './$types';
  import type { RichText } from '$lib/blog/types';
  import { hljs } from '$lib/highlight';

  const { data }: { data: PageData } = $props();

  type Block = PageData['blocks'][number];
</script>

<div
  class="font-garamond max-w-screen px-3 sm:max-w-[75vw] sm:px-0 xl:max-w-[60vw] 2xl:max-w-[clamp(0rem,60vw,75rem)]"
>
  <h1 class="text-2xl font-black">{data.title}</h1>
  <p class="mb-4">{data.createdTime}</p>

  {#each data.blocks as block}
    {@render blockRender(block)}
  {/each}
</div>

<svelte:head>
  <title>{data.title}</title>
  <meta name="description" content={`${data.title} by Jason Kwok`} />
  <meta property="og:title" content={`${data.title} by Jason Kwok (Pandoks_)`} />
  <meta property="og:description" content={`${data.title} by Jason Kwok`} />
</svelte:head>

{#snippet blockRender(block: Block)}
  {#if block.type === 'heading_1'}
    <h2 class="text-xl font-extrabold">{@render textBlockRender(block.texts)}</h2>
  {:else if block.type === 'heading_2'}
    <h3 class="text-lg font-bold">{@render textBlockRender(block.texts)}</h3>
  {:else if block.type === 'heading_3'}
    <h4 class="font-semibold">{@render textBlockRender(block.texts)}</h4>
  {:else if block.type === 'paragraph'}
    <p class="mb-4">{@render textBlockRender(block.texts)}</p>
  {:else if block.type === 'break'}
    <br />
  {:else if block.type === 'image'}
    <enhanced:img class="mx-auto mb-4 rounded-xs" src={block.picture} alt="A thousand words" />
  {:else if block.type === 'code'}
    <pre
      class="bg-highlight scrollbar-thin mb-4 overflow-x-auto rounded-xs p-4"
      style="scrollbar-width: thin;">
      <code class="font-mono text-xs lg:text-sm">
        {@html hljs.highlight(block.code, { language: block.language }).value}
      </code>
    </pre>
  {/if}
{/snippet}

{#snippet textBlockRender(textData: RichText[])}
  {#each textData as { plain_text, annotations, href }}
    {#if href}
      <a
        {href}
        target="_blank"
        rel="noopener noreferrer"
        class={`text-neutral-500 hover:cursor-pointer hover:underline
              ${annotations.bold ? 'font-medium' : ''}
              ${annotations.italic ? 'italic' : ''}
              ${annotations.strikethrough ? 'line-through' : ''}
              ${annotations.underline ? 'underline' : ''}`}
      >
        {plain_text}
      </a>
    {:else}
      <span
        class={`${annotations.bold ? 'font-medium' : ''}
              ${annotations.italic ? 'italic' : ''}
              ${annotations.strikethrough ? 'line-through' : ''}
              ${annotations.underline ? 'underline' : ''}`}
      >
        {plain_text}
      </span>
    {/if}
  {/each}
{/snippet}
