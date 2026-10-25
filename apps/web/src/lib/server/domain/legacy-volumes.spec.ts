import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deployment, serviceInstance } from '../db/schema';
import { seedCtx } from '../testing';
import * as changes from './changes';
import * as deployments from './deployments';
import * as environments from './environments';
import * as projects from './projects';
import * as services from './services';
import { appliedConfig } from './staging';

/** Databases created before volumes existed: their saved configs have no volume section. */
function setup() {
	const ctx = seedCtx();
	const project = projects.create(ctx, { name: 'Shop' });
	const [env] = environments.list(ctx, project.id);
	const redis = services.create(ctx, { projectId: project.id, kind: 'database', engine: 'redis' });
	const web = services.create(ctx, {
		projectId: project.id,
		kind: 'image',
		source: { type: 'image', image: 'traefik/whoami' }
	});
	const pg = services.create(ctx, { projectId: project.id, kind: 'database', engine: 'postgres' });
	// a volume someone detached on purpose
	services.stageConfig(ctx, pg.id, env!.id, { volume: { mountPath: null } });
	const [dep] = changes.deploy(ctx, env!.id).filter((d) => d.serviceId === redis.id);

	const strip = (config: Record<string, unknown>) => {
		const legacy = { ...config };
		delete legacy.volume;
		return legacy;
	};
	for (const id of [redis.id, web.id]) {
		const config = appliedConfig(ctx.db, id, env!.id)!;
		ctx.db
			.update(serviceInstance)
			.set({ config: strip(config) as never })
			.where(eq(serviceInstance.serviceId, id))
			.run();
	}
	const snapshot = ctx.db.select().from(deployment).where(eq(deployment.id, dep!.id)).get()!;
	ctx.db
		.update(deployment)
		.set({ config: strip(snapshot.config) as never })
		.where(eq(deployment.id, dep!.id))
		.run();
	return { ctx, env: env!, redis, web, pg, dep: dep! };
}

const stored = (ctx: ReturnType<typeof seedCtx>, serviceId: string) =>
	ctx.db
		.select({ config: serviceInstance.config })
		.from(serviceInstance)
		.where(eq(serviceInstance.serviceId, serviceId))
		.get()!.config as Record<string, unknown>;

describe('databases from before volumes', () => {
	it('the migration gives them their template volume, and leaves everything else alone', () => {
		const { ctx, redis, web, pg } = setup();
		expect(stored(ctx, redis.id).volume).toBeUndefined();

		ctx.db.$client.exec(readFileSync('drizzle/0018_database_volumes.sql', 'utf8'));

		expect(stored(ctx, redis.id).volume).toEqual({ mountPath: '/data' });
		expect(stored(ctx, web.id).volume).toBeUndefined();
		expect(stored(ctx, pg.id).volume).toEqual({ mountPath: null });
	});

	it('a redeploy of an old snapshot takes the service’s volume', () => {
		const { ctx, env, redis, dep } = setup();
		ctx.db.$client.exec(readFileSync('drizzle/0018_database_volumes.sql', 'utf8'));

		const again = deployments.redeploy(ctx, dep.id);
		const row = ctx.db.select().from(deployment).where(eq(deployment.id, again.id)).get()!;
		expect(row.config.volume).toEqual({ mountPath: '/data' });
		expect(appliedConfig(ctx.db, redis.id, env.id)!.volume).toEqual({ mountPath: '/data' });

		// a snapshot that has the section is copied exactly
		const twice = deployments.redeploy(ctx, again.id);
		expect(
			ctx.db.select().from(deployment).where(eq(deployment.id, twice.id)).get()!.config
		).toEqual(row.config);
	});
});
