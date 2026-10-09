<script lang="ts">
  import { setAuthNavigator, setSeamlessAuth } from '@seamless-auth/svelte';
  import { createKitNavigator } from '@seamless-auth/svelte/kit';

  import { auth } from '#lib/auth';

  let { children } = $props();

  setSeamlessAuth(auth);
  setAuthNavigator(createKitNavigator(auth));
</script>

{@render children()}
