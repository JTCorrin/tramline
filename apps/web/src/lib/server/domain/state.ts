import type { ServiceConfig } from '@tramline/contracts';
import type { DbOrTx } from '../db/client';
import type { Secrets } from '../crypto';
import { and, asc, eq } from 'drizzle-orm';
import { environment, service, serviceInstance, type StagedPayload } from '../db/schema';
import { appliedConfig, effectiveConfig, getStaged } from './staging';
import { appliedVariables, effectiveVariables } from './variables';

export interface ServiceState {
	service: typeof service.$inferSelect;
	applied: ServiceConfig | null;
	staged: StagedPayload;
	effective: ServiceConfig;
	appliedVariables: Record<string, string>;
	effectiveVariables: Record<string, string>;
	/** Generated public hostname, once one exists. */
	domain: string | null;
	/** Edge port of its TCP proxy, once assigned. */
	tcpPort: number | null;
}

export interface EnvironmentState {
	environment: typeof environment.$inferSelect;
	shared: {
		staged: StagedPayload;
		applied: Record<string, string>;
		effective: Record<string, string>;
	};
	services: ServiceState[];
}

/** Applied and staged state of every service in one environment. */
export function loadEnvironmentState(
	db: DbOrTx,
	secrets: Secrets,
	env: typeof environment.$inferSelect
): EnvironmentState {
	const services = db
		.select()
		.from(service)
		.where(eq(service.projectId, env.projectId))
		.orderBy(asc(service.createdAt), asc(service.id))
		.all();

	return {
		environment: env,
		shared: {
			staged: getStaged(db, env.id, null),
			applied: appliedVariables(db, secrets, env.id, null),
			effective: effectiveVariables(db, secrets, env.id, null)
		},
		services: services.map((svc) => {
			const applied = appliedConfig(db, svc.id, env.id);
			const staged = getStaged(db, env.id, svc.id);
			const instance = db
				.select({ domain: serviceInstance.domain, tcpPort: serviceInstance.tcpPort })
				.from(serviceInstance)
				.where(
					and(eq(serviceInstance.serviceId, svc.id), eq(serviceInstance.environmentId, env.id))
				)
				.get();
			return {
				service: svc,
				applied,
				staged,
				effective: effectiveConfig(applied, staged),
				appliedVariables: appliedVariables(db, secrets, env.id, svc.id),
				effectiveVariables: effectiveVariables(db, secrets, env.id, svc.id),
				domain: instance?.domain ?? null,
				tcpPort: instance?.tcpPort ?? null
			};
		})
	};
}

export const hasStaged = (payload: StagedPayload) =>
	Boolean(
		payload.create ||
		(payload.config && Object.keys(payload.config).length) ||
		(payload.variables &&
			(Object.keys(payload.variables.set).length || payload.variables.unset.length))
	);
