<script lang="ts">
  import { Badge } from '@pandoks.com/svelte/shadcn/badge';
  const { data } = $props();
</script>

{#if data.titles.length}
  <ul class="list-disc">
    {#each data.titles as title}
      <li>
        {@render blogTitle(title)}
      </li>
    {/each}
  </ul>
{:else}
  <Badge
    class="border-neutral-300 bg-white/75 px-4 py-1 text-sm text-neutral-600"
    variant="outline"
  >
    Coming Soon
  </Badge>
{/if}

{#snippet blogTitle(title: string)}
  <a
    class="font-garamond flex flex-col hover:cursor-pointer hover:underline"
    href="/blog/{title.replaceAll(' ', '-')}"
  >
    {title}
  </a>
{/snippet}
