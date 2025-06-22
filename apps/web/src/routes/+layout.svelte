<script lang="ts">
  import '../app.css';

  let { children } = $props();
</script>

<div>
  <nav class="font-garamond flex flex-col">
    <a data-sveltekit-preload-code href="/">Jason Kwok</a>
    <a data-sveltekit-preload-code href="/blog">Blog</a>
  </nav>
  {@render children()}
</div>
