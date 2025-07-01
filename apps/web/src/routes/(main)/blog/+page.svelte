<script lang="ts">
  import { Input } from '@pandoks.com/svelte/shadcn/input';

  const { data } = $props();
  let searchTerm = $state('');

  const filteredPosts = $derived(
    data.posts.filter(
      (post) =>
        post.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        post.summary.toLowerCase().includes(searchTerm.toLowerCase())
    )
  );
</script>

<div class="flex h-full w-full max-w-2xl flex-col gap-4 px-4">
  <div class="flex-shrink-0">
    <Input bind:value={searchTerm} placeholder="Search blog posts..." class="w-full" />
  </div>

  <div class="min-h-0 flex-1 space-y-4 overflow-y-auto">
    {#each filteredPosts as post}
      {@render blogPage(post)}
    {/each}
  </div>
</div>

{#snippet blogPage(post: {
  title: string;
  summary: string;
  createdTime: Date;
  lastEditedTime: Date;
})}
  <a
    class="font-garamond flex flex-col hover:cursor-pointer hover:underline"
    href="/blog/{post.title}"
  >
    <h1 class="text-xl">{post.title}</h1>
    <p class="text-wrap">{post.summary}</p>
  </a>
{/snippet}
