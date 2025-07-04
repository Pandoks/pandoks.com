<script lang="ts">
  const { data } = $props();
</script>

<ul class="list-disc">
  {#each data.titles as title}
    <li>
      {@render blogTitle(title)}
    </li>
  {/each}
</ul>

{#snippet blogTitle(title: string)}
  <a
    class="font-garamond flex flex-col hover:cursor-pointer hover:underline"
    href="/blog/{title.replaceAll(' ', '-')}"
  >
    {title}
  </a>
{/snippet}
