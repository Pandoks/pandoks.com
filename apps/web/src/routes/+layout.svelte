<script lang="ts">
  import { page } from '$app/state';
  import '../app.css';

  let { children } = $props();
</script>

<nav
  class="font-inter fixed top-1/2 flex -translate-y-9/12 flex-col space-y-3 text-sm sm:pl-3 md:pl-7"
>
  {@render navLink('/', 'Jason Kwok')}
  {@render navLink('/socials', 'Socials')}
  {@render navLink('/work', 'Work')}
  {@render navLink('/blog', 'Blog')}
</nav>

<div
  class="flex min-h-screen items-center pr-[clamp(1rem,1vw,5rem)] pl-[clamp(6rem,20vw,13rem)] lg:justify-center lg:px-0"
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
