<script lang="ts">
  import * as Sidebar from '@pandoks.com/svelte/shadcn/sidebar';

  const { children } = $props();
</script>

{@render children()}
