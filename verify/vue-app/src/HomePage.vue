<script setup lang="ts">
import { useSeamlessAuth } from '@seamless-auth/vue';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

// The accessible names here ("Open account menu", "Logout", "You are signed in")
// are a cross-repo contract with the browser specs, shared with the React
// template.
const auth = useSeamlessAuth();
const router = useRouter();
const menuOpen = ref(false);
const identity = computed(() => auth.user.value?.email || auth.user.value?.phone || 'you');

async function logout() {
  await auth.logout();
  await router.push('/login');
}
</script>

<template>
  <header>
    <button
      type="button"
      aria-label="Open account menu"
      :aria-expanded="menuOpen"
      @click="menuOpen = !menuOpen"
    >
      {{ identity }}
    </button>
    <div v-if="menuOpen">
      <button type="button" @click="logout">Logout</button>
    </div>
  </header>
  <main>
    <h1>You are signed in</h1>
    <p>Signed in as {{ identity }}.</p>
  </main>
</template>
