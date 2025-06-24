<script lang="ts">
  import { page } from '$app/state';
  import '../app.css';

  let { children } = $props();
</script>

<nav
  class="font-inter fixed top-1/2 flex -translate-y-9/12 flex-col space-y-3 pl-[clamp(0rem,1.5vw,4rem)] text-sm"
>
  {@render navLink('/', 'Jason Kwok')}
  {@render navLink('/socials', 'Socials')}
  {@render navLink('/work', 'Work')}
  {@render navLink('/blog', 'Blog')}
</nav>

<div
  class="flex min-h-screen items-center pr-4 pl-[clamp(0rem,17.8vw,11.4rem)] lg:justify-center lg:px-0"
>
  {@render children()}
</div>

{#snippet navLink(href: string, text: string)}
  <a
    data-sveltekit-preload-code
    {href}
    class={page.route.id === href ? 'underline' : 'hover:underline'}>{text}</a
  >
{/snippet}
