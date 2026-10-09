import { requireAuth } from '@seamless-auth/svelte/kit';

import { auth } from '#lib/auth';

export const load = requireAuth(auth);
