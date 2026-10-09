import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideSeamlessAuth } from '@seamless-auth/angular';

import { routes } from './app.routes';

declare global {
  interface Window {
    __SEAMLESS_CONFIG__?: { API_URL?: string };
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    // The adapter origin is read at runtime, so one image serves any stack.
    provideSeamlessAuth(() => ({
      apiHost: window.__SEAMLESS_CONFIG__?.API_URL ?? 'http://localhost:3000',
    })),
  ],
};
