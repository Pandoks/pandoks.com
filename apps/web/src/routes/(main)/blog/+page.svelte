<script lang="ts">
  const { data } = $props();
</script>

<ul class="scrollbar-thin ml-15 max-h-[40vh] list-inside list-disc overflow-y-auto pr-10">
  {#each data.titles as title}
    <li>
      {@render blogTitle(title)}
    </li>
  {/each}
</ul>

{#snippet blogTitle(title: string)}
  <a class="font-garamond flex flex-col hover:cursor-pointer hover:underline" href="/blog/{title}">
    <h1>{title}</h1>
  </a>
{/snippet}
