import { createClient } from '@tramline/client';

/**
 * The Tramline API client for this app. In `load` functions pass SvelteKit's
 * `fetch` so requests carry the session cookie during SSR.
 */
export const api = (fetch?: typeof globalThis.fetch) => createClient({ baseUrl: '/api/v1', fetch });

export { ApiError } from '@tramline/client';
