<script lang="ts">
  import '$lib/styles/fonts.css';
  import '../app.css';
  import type { Snippet } from 'svelte';

  const { children }: { children: Snippet } = $props();
</script>

{@render children()}
