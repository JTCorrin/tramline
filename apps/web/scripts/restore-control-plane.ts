/**
 * Restores Tramline's own database from an encrypted snapshot.
 *
 *   pnpm --filter @tramline/web restore-control-plane --list
 *   pnpm --filter @tramline/web restore-control-plane --check [--snapshot <key>]
 *   pnpm --filter @tramline/web restore-control-plane --yes [--snapshot <key>]
 *
 * Reads TRAMLINE_SECRET_KEY, TRAMLINE_DATABASE_PATH and TRAMLINE_BACKUP_S3_*
 * from the environment (and apps/web/.env). Stop Tramline before restoring:
 * the current database is kept next to the restored one.
 */
import { parseArgs } from 'node:util';
import {
	controlPlaneBucket,
	drillControlPlane,
	listSnapshots,
	restoreControlPlane,
	snapshotKey
} from '../src/lib/server/backups/control-plane';

const { values } = parseArgs({
	options: {
		list: { type: 'boolean' },
		check: { type: 'boolean' },
		yes: { type: 'boolean' },
		snapshot: { type: 'string' }
	}
});

const bucket = controlPlaneBucket(process.env);
const secret = process.env.TRAMLINE_SECRET_KEY;
if (!bucket || !secret) {
	console.error('Set TRAMLINE_SECRET_KEY and TRAMLINE_BACKUP_S3_* (endpoint, bucket and keys).');
	process.exit(1);
}
const key = snapshotKey(secret);

if (values.list) {
	const snapshots = await listSnapshots(bucket);
	console.log(snapshots.length ? snapshots.join('\n') : 'No snapshots yet.');
} else if (values.check) {
	const result = await drillControlPlane(bucket, key);
	console.log(`${result.snapshot} decrypts and passes SQLite's integrity check:`);
	console.log(
		`  ${result.organizations} organizations, ${result.projects} projects, ${result.deployments} deployments`
	);
} else if (values.yes) {
	const database = process.env.TRAMLINE_DATABASE_PATH || 'data/tramline.db';
	const { snapshot, kept } = await restoreControlPlane(bucket, key, database, {
		name: values.snapshot
	});
	console.log(`Restored ${database} from ${snapshot}.`);
	console.log(`The previous database is at ${kept}. Start Tramline again.`);
} else {
	console.error('Stop Tramline first, then run with --yes to restore (or --list, --check).');
	process.exit(1);
}
