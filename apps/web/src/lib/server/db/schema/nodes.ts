import type { AgentHello, ScanResult } from '@tramline/contracts';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth';
import { timestamps } from './projects';

/**
 * A connection to a compute provider (Proxmox, a cloud) that creates
 * machines. Like nodes, accounts belong to the install. The credentials are
 * one encrypted JSON object, checked against the adapter's schema.
 */
export const adapterAccount = sqliteTable('adapter_account', {
	id: text('id').primaryKey(),
	adapter: text('adapter').notNull(),
	name: text('name').notNull().unique(),
	credentials: text('credentials').notNull(),
	createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
	...timestamps
});

/** A machine running the Tramline agent. Nodes belong to the install, not an organization. */
export const node = sqliteTable('node', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(),
	/** Which compute adapter manages it; `manual` for machines enrolled by hand. */
	adapter: text('adapter').notNull().default('manual'),
	/** The account that created the machine; removing the node destroys it there. */
	adapterAccountId: text('adapter_account_id').references(() => adapterAccount.id),
	/** The provider's ID for the machine. */
	providerNodeId: text('provider_node_id'),
	/** sha256 of the agent's bearer token. */
	tokenHash: text('token_hash').notNull().unique(),
	/** Last hello from the agent. */
	info: text('info', { mode: 'json' }).$type<AgentHello>(),
	/** e.g. "Docker isn't running". */
	error: text('error'),
	lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
	/** Desired-state revision the agent last converged to. */
	revision: text('revision'),
	/** Takes no new deployments. */
	cordoned: integer('cordoned', { mode: 'boolean' }).notNull().default(false),
	/** Cordoned, with its stateless deployments moving elsewhere. */
	draining: integer('draining', { mode: 'boolean' }).notNull().default(false),
	/** Serves every public domain, forwarding to other nodes over the mesh. */
	edge: integer('edge', { mode: 'boolean' }).notNull().default(false),
	/** WireGuard public key the agent generated; the private key stays on the node. */
	meshPublicKey: text('mesh_public_key'),
	/** Its address in the mesh, assigned when it first reports a key. */
	meshAddress: text('mesh_address').unique(),
	/** `host:port` other nodes reach it on (UDP); null behind NAT. */
	meshEndpoint: text('mesh_endpoint'),
	/** The latest agent update asked for from the Nodes page, and how the agent says it went. */
	agentUpdate: text('agent_update', { mode: 'json' }).$type<AgentUpdate>(),
	...timestamps
});

export interface AgentUpdate {
	id: string;
	state: 'requested' | 'running' | 'succeeded' | 'failed';
	detail: string | null;
	error: string | null;
	requestedBy: string | null;
	requestedAt: string;
	finishedAt: string | null;
}

/**
 * A one-time token a new machine trades for its node token. Only the hash is
 * kept; it expires after an hour and can be used once.
 */
export const joinToken = sqliteTable('join_token', {
	id: text('id').primaryKey(),
	tokenHash: text('token_hash').notNull().unique(),
	/** The name the node gets. */
	name: text('name').notNull(),
	/** The node starts cordoned. */
	cordoned: integer('cordoned', { mode: 'boolean' }).notNull().default(false),
	/** For a machine an adapter created: the account, and the machine it made. */
	adapterAccountId: text('adapter_account_id').references(() => adapterAccount.id),
	providerNodeId: text('provider_node_id'),
	region: text('region'),
	offer: text('offer'),
	/**
	 * sha256 of the ID in the machine's cloud-init seed URL, and the user data
	 * it serves (encrypted; it holds the join token). Both go once it enrolls.
	 */
	seedHash: text('seed_hash').unique(),
	seed: text('seed'),
	createdBy: text('created_by'),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
	usedAt: integer('used_at', { mode: 'timestamp_ms' }),
	/** The node it enrolled. */
	nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
	...timestamps
});

/** Builds as last reported by a node's agent. Replaced wholesale on every report. */
export const build = sqliteTable('build', {
	deploymentId: text('deployment_id').primaryKey(),
	nodeId: text('node_id')
		.notNull()
		.references(() => node.id, { onDelete: 'cascade' }),
	state: text('state', { enum: ['running', 'succeeded', 'failed'] }).notNull(),
	image: text('image'),
	commit: text('commit'),
	error: text('error'),
	scan: text('scan', { mode: 'json' }).$type<ScanResult>(),
	updatedAt: timestamps.updatedAt
});

/** Containers as last reported by a node's agent. Replaced wholesale on every report. */
export const container = sqliteTable(
	'container',
	{
		name: text('name').primaryKey(),
		nodeId: text('node_id')
			.notNull()
			.references(() => node.id, { onDelete: 'cascade' }),
		deploymentId: text('deployment_id').notNull(),
		replica: integer('replica').notNull(),
		state: text('state', {
			enum: ['pulling', 'starting', 'running', 'restarting', 'exited', 'error']
		}).notNull(),
		healthy: integer('healthy', { mode: 'boolean' }),
		exitCode: integer('exit_code'),
		restartCount: integer('restart_count').notNull().default(0),
		error: text('error'),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }),
		imageDigest: text('image_digest'),
		updatedAt: timestamps.updatedAt
	},
	(table) => [index('container_deployment_idx').on(table.deploymentId)]
);

/**
 * People who manage this install's nodes. Granted explicitly: the first by
 * the one-time setup token, later ones by an existing admin.
 */
export const installAdmin = sqliteTable('install_admin', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	grantedBy: text('granted_by'),
	grantedAt: integer('granted_at', { mode: 'timestamp_ms' })
		.notNull()
		.$defaultFn(() => new Date())
});

/**
 * The install's tunnel, which gives nodes elsewhere a public address for
 * this install without opening a port. There is at most one row. Tramline
 * created the tunnel and its DNS record with `apiToken`, and removes them
 * with it; `tunnelToken` is what the connector runs with. Both are encrypted.
 */
export const publicTunnel = sqliteTable('public_tunnel', {
	id: text('id').primaryKey(),
	provider: text('provider').$type<'cloudflare'>().notNull(),
	hostname: text('hostname').notNull(),
	apiToken: text('api_token').notNull(),
	accountId: text('account_id').notNull(),
	zoneId: text('zone_id').notNull(),
	zoneName: text('zone_name').notNull(),
	tunnelId: text('tunnel_id').notNull(),
	dnsRecordId: text('dns_record_id').notNull(),
	tunnelToken: text('tunnel_token').notNull(),
	/** Where the connector reaches this install, e.g. http://localhost:3000. */
	originUrl: text('origin_url').notNull(),
	/** The node that runs the connector; null when it's run by hand. */
	nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
	/**
	 * DNS records Tramline made for services published through the tunnel, by
	 * hostname. Kept here rather than with the domains, so a record whose domain
	 * went away (its service or environment was deleted) is still found and removed.
	 */
	appRecords: text('app_records', { mode: 'json' }).$type<Record<string, string>>(),
	createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
	...timestamps
});
