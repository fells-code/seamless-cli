<script lang="ts">
  import { goto } from '$app/navigation';
  import { getSeamlessAuth } from '@seamless-auth/svelte';

  // The accessible names here ("Open account menu", "Logout", "You are signed in")
  // are a cross-repo contract with the browser specs, shared with the React
  // template.
  const auth = getSeamlessAuth();
  let menuOpen = $state(false);
  const identity = $derived(auth.user?.email || auth.user?.phone || 'you');

  async function logout() {
    await auth.logout();
    await goto('/login');
  }
</script>

<header>
  <button
    type="button"
    aria-label="Open account menu"
    aria-expanded={menuOpen}
    onclick={() => (menuOpen = !menuOpen)}
  >
    {identity}
  </button>
  {#if menuOpen}
    <div>
      <button type="button" onclick={logout}>Logout</button>
    </div>
  {/if}
</header>
<main>
  <h1>You are signed in</h1>
  <p>Signed in as {identity}.</p>
</main>
