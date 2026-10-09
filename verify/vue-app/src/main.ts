import { createSeamlessAuth } from '@seamless-auth/vue';
import { authGuard, createSeamlessAuthRoutes, guestGuard } from '@seamless-auth/vue/router';
import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

import App from './App.vue';
import HomePage from './HomePage.vue';

declare global {
  interface Window {
    __SEAMLESS_CONFIG__?: { API_URL?: string };
  }
}

// Screens that start a sign-in are for signed-out visitors only. The ones that
// finish one (a code, a link, a provider callback, passkey enrolment) are not
// guarded: the session can already exist by the time they render.
const entryScreens = new Set(['/login', '/passkey-login', '/magic-link-sent']);

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: HomePage, beforeEnter: authGuard },
    ...createSeamlessAuthRoutes().map(route =>
      entryScreens.has(route.path) ? { ...route, beforeEnter: guestGuard } : route
    ),
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

createApp(App)
  .use(router)
  // The adapter origin is read at runtime, so one image serves any stack.
  .use(
    createSeamlessAuth({
      apiHost: window.__SEAMLESS_CONFIG__?.API_URL ?? 'http://localhost:3000',
    })
  )
  .mount('#app');
