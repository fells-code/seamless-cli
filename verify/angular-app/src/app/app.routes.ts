import { Routes } from '@angular/router';
import { authGuard, guestGuard } from '@seamless-auth/angular';
import { authRoutePaths, seamlessAuthRoutes } from '@seamless-auth/angular/routes';

import { Home } from './home';

// Screens that start a sign-in are for signed-out visitors only. The ones that
// finish one (a code, a link, a provider callback, passkey enrolment) are not
// guarded: the session can already exist by the time they render.
const entryScreens = new Set<string>([
  authRoutePaths.login,
  authRoutePaths.passkeyLogin,
  authRoutePaths.magicLinkSent,
]);

export const routes: Routes = [
  { path: '', component: Home, canActivate: [authGuard] },
  ...seamlessAuthRoutes.map(route =>
    entryScreens.has(route.path ?? '') ? { ...route, canActivate: [guestGuard] } : route
  ),
  { path: '**', redirectTo: '' },
];
