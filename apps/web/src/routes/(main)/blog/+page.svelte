<script lang="ts">
  const { data } = $props();
</script>

<ul class="scrollbar-thin mb-[15vh] ml-15 h-[45vh] list-inside list-disc overflow-y-auto pr-10">
  {#each data.titles as title}
    <li>
      {@render blogPage(title)}
    </li>
  {/each}
</ul>

{#snippet blogPage(title: string)}
  <a class="font-garamond flex flex-col hover:cursor-pointer hover:underline" href="/blog/{title}">
    <h1>{title}</h1>
  </a>
{/snippet}
