<script lang="ts">
  let url = 'https://google.com';
  
  function navigate() {
    if (!url.trim()) return;
    
    let finalUrl = url.trim();
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      finalUrl = 'https://' + finalUrl;
    }
    
    window.electronAPI.navigate(finalUrl);
  }
  
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      navigate();
    }
  }
</script>

<!-- Standard browser layout -->
<div class="h-screen w-screen flex flex-col">
  <!-- URL bar at the top (60px) -->
  <div class="h-[60px] p-2.5 bg-gray-100 border-b border-gray-300 flex items-center gap-2.5">
    <input 
      bind:value={url} 
      on:keydown={handleKeydown}
      placeholder="Enter URL..."
      class="flex-1 px-3 py-2 border border-gray-300 rounded text-sm bg-white"
    />
    <button on:click={navigate} class="px-4 py-2 bg-blue-600 text-white border-none rounded cursor-pointer">
      Go
    </button>
  </div>
  
  <!-- Empty space where WebContentsView will be embedded -->
  <div class="flex-1 bg-white">
    <!-- WebContentsView will fill this area -->
  </div>
</div>
