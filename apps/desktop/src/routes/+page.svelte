<script lang="ts">
  let proximityHover = $state(false);
  let showFull = $state(false);
</script>

<div
  class="fixed top-0 left-1/2 -translate-x-1/2 items-center bg-amber-200 px-5 pb-3"
  role="presentation"
  onmouseenter={() => (proximityHover = true)}
  onmouseleave={() => ((proximityHover = false), (showFull = false))}
>
  <button
    class="w-20 transform-gpu bg-red-300 px-4 py-2 transition-all duration-100 ease-in"
    class:-translate-y-2={!proximityHover}
    class:w-screen={showFull}
    class:rounded-b-lg={!showFull}
    onmouseenter={() => (showFull = true)}
  >
    hi
  </button>
</div>
