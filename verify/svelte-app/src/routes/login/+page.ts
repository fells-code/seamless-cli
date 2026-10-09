import { requireGuest } from '@seamless-auth/svelte/kit';

import { auth } from '#lib/auth';

export const load = requireGuest(auth);
