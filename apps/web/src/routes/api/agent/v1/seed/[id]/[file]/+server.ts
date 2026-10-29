import { secrets } from '#lib/server/api/handler.js';
import { db } from '#lib/server/db/index.js';
import { seedFile } from '#lib/server/domain/adapters.js';
import type { RequestHandler } from './$types';

/**
 * Cloud-init's NoCloud seed for a machine an adapter is creating (Proxmox
 * points the VM here through its SMBIOS serial). The unguessable seed ID is
 * the only credential, and it stops working once the machine enrolls.
 */
export const GET: RequestHandler = ({ params }) => {
	const body = seedFile(db, secrets, params.id, params.file);
	if (body === null) return new Response('Not found\n', { status: 404 });
	return new Response(body, {
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
};
