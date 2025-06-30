<script lang="ts">
  import { Badge } from '@pandoks.com/svelte/shadcn/badge';

  const { data } = $props();
</script>

{JSON.stringify(data.posts)}
