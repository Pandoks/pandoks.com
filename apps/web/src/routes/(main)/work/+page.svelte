<script lang="ts">
  import { Badge } from '@pandoks.com/svelte/shadcn/badge';
</script>

<div class="flex flex-col items-center gap-4">
  <Badge
    class="border-neutral-300 bg-white/75 px-4 py-1 text-sm text-neutral-600"
    variant="outline"
  >
    More to Come
  </Badge>

  <ul class="scrollbar-thin ml-10 max-h-[25vh] list-inside list-disc overflow-y-auto pr-10">
    <li class="font-garamond">
      I currently strain solids and liquids at
      <a href="https://www.sievedata.com" target="_blank" class="font-medium hover:underline"
        >Sieve</a
      >.
    </li>
  </ul>
</div>
