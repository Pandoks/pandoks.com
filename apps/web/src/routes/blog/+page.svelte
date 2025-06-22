<script lang="ts">
  import { dev } from '$app/environment';
  import type { PageProps } from './$types';

  const { data }: PageProps = $props();
</script>

{#each data.posts as post}
  <div class="flex flex-col">
    {@render blogPost(post)}
  </div>
{/each}

{#snippet blogPost(post)}
  <h1 class="font-garamond font-medium">
    Title: {post.title}
  </h1>

  <h2 class="font-garamond font-medium">
    Summary: {post.summary}
  </h2>

  <p>Content:</p>
  {#each post.blocks as block}
    {@render notionBlock(block)}
  {/each}
{/snippet}

{#snippet notionBlock(block)}
  {#if block.type === 'paragraph'}
    <p>{block.text}</p>
  {:else if block.type === 'heading_1'}
    <h1>{block.text}</h1>
  {:else if block.type === 'heading_2'}
    <h2>{block.text}</h2>
  {:else if block.type === 'heading_3'}
    <h3>{block.text}</h3>
  {:else if block.type === 'bulleted_list_item'}
    <li>{block.text}</li>
  {:else if block.type === 'image'}
    {#if dev}
      <img src={block.url} alt={block.text} />
    {:else}
      <enhanced:img src={block.url} alt={block.text} />
    {/if}
  {/if}
{/snippet}
