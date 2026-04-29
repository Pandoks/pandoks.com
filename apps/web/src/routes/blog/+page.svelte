<script lang="ts">
  import { goto } from '$app/navigation';
  import { getVimState } from '$lib/vim.svelte.js';
  import { Badge } from '@pandoks.com/svelte/shadcn/badge';

  let activeBlogIndex: number | undefined = $state();
  const vimState = getVimState()
    .setBodyHandler((e) => {
      switch (e.key) {
        case 'j':
          if (activeBlogIndex === __BLOG_INDEX__.length - 2) {
            // NOTE: You want to set bottom to true on the second to last item because once you've
            // reached the last item, you want the vim state to take over
            vimState.bodyBottom = true;
          }
          activeBlogIndex!++;
          if (__BLOG_INDEX__.length > 1) {
            vimState.bodyTop = false;
          }
          return;
        case 'k':
          if (activeBlogIndex === 1) {
            // NOTE: same note as above but now you're going up
            vimState.bodyTop = true;
          }

          activeBlogIndex!--;
          if (__BLOG_INDEX__.length > 1) {
            vimState.bodyBottom = false;
          }
          return;
        case 'Enter':
          if (activeBlogIndex !== undefined) {
            vimState.active = 'none';
            goto(`/blog/${__BLOG_INDEX__[activeBlogIndex].slug}`);
          }
          return;
      }
    })
    .setInitBodyState((e: KeyboardEvent) => {
      if (e.key === 'j') {
        activeBlogIndex = 0;
        if (__BLOG_INDEX__.length > 1) {
          vimState.bodyBottom = false;
        }
      }
      if (e.key === 'k') {
        activeBlogIndex = __BLOG_INDEX__.length - 1;
        vimState.bodyBottom = true;
        if (__BLOG_INDEX__.length > 1) {
          vimState.bodyTop = false;
        }
      }
    })
    .setResetBodyState(() => {
      activeBlogIndex = undefined;
    });
</script>

{#if __BLOG_INDEX__.length}
  <ul class="list-disc text-lg">
    {#each __BLOG_INDEX__ as post, index}
      <li>
        {@render blogTitle(post, index)}
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

{#snippet blogTitle(post: { slug: string; title: string }, index: number)}
  <a
    class={`${activeBlogIndex === index && vimState.active === 'body' ? 'bg-highlight' : ''} font-garamond flex flex-col hover:cursor-pointer hover:underline`}
    href="/blog/{post.slug}"
  >
    {post.title}
  </a>
{/snippet}

<svelte:head>
  <title>Pandoks Blog</title>
  <meta name="description" content="Jason Kwok's blog" />
  <meta property="og:title" content="Jason Kwok's Blog (Pandoks_'s Blog)" />
  <meta
    property="og:description"
    content="Jason Kwok's blog which includes articles about his experiences and thoughts"
  />
</svelte:head>
