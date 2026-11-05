import {
	TUNNEL_PATHS,
	type CloudflareZone,
	type CreatePublicTunnel,
	type ListCloudflareZones,
	type PublicAccess,
	type TunnelConnector,
	type TunnelStatus,
	type UpdatePublicTunnel
} from '@tramline/contracts';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AppError, notFound } from '../api/errors';
import { cloudflare } from '../cloudflare';
import type { Secrets } from '../crypto';
import type { DbOrTx } from '../db/client';
import { node, publicTunnel } from '../db/schema';
import { newId } from '../ids';
import { notifyNodes } from '../nodes/bus';
import { nodeStatus } from '../nodes/registry';
import type { PlatformSettings } from '../settings';
import { requireInstallAdmin } from './admins';
import type { Ctx } from './context';

/**
 * Public access: the address new nodes are told to connect to. A tunnel
 * Tramline creates with Cloudflare comes first, then TRAMLINE_AGENT_URL,
 * then TRAMLINE_URL. The tunnel carries only the agent API and the install
 * script, so the dashboard stays wherever it was.
 */

export const TUNNEL_IMAGE = 'cloudflare/cloudflared:2026.10.0';
export const tunnelContainerName = (nodeId: string) => `tramline-tunnel-${nodeId}`;

type Row = typeof publicTunnel.$inferSelect;

const tunnelRow = (db: DbOrTx) => db.select().from(publicTunnel).get();

/** Where nodes reach this install, or null to use the address the request came to. */
export function agentUrl(db: DbOrTx, settings: PlatformSettings) {
	const tunnel = tunnelRow(db);
	if (tunnel) return `https://${tunnel.hostname}`;
	return (settings.agentUrl ?? settings.publicUrl)?.replace(/\/$/, '') ?? null;
}

/** The connector a node runs, if it's the one chosen. */
export function desiredTunnel(db: DbOrTx, secrets: Secrets, nodeId: string) {
	const tunnel = tunnelRow(db);
	if (!tunnel || tunnel.nodeId !== nodeId) return null;
	return {
		name: tunnelContainerName(nodeId),
		image: TUNNEL_IMAGE,
		token: secrets.decrypt(tunnel.tunnelToken)
	};
}

const ingressRules = (hostname: string, originUrl: string) => [
	{ hostname, path: TUNNEL_PATHS, service: originUrl },
	{ service: 'http_status:404' }
];

/** Why a node can't run the connector, or null when it can. */
function connectorProblem(db: DbOrTx, nodeId: string) {
	const row = db.select().from(node).where(eq(node.id, nodeId)).get();
	if (!row) return 'The node chosen to run the connector no longer exists.';
	if (!row.info?.features?.includes('tunnel')) {
		return `${row.name}'s agent is too old to run the connector. Reinstall the agent on it, or choose another node.`;
	}
	if (nodeStatus(row) === 'offline') {
		return `${row.name} is offline, so the connector isn't running.`;
	}
	return null;
}

function requireNodeId(db: DbOrTx, nodeId: string | null) {
	if (!nodeId) return;
	const row = db
		.select({ name: node.name, info: node.info })
		.from(node)
		.where(eq(node.id, nodeId))
		.get();
	if (!row) throw notFound('Node');
	if (!row.info?.features?.includes('tunnel')) {
		throw new AppError(
			'conflict',
			`${row.name}'s agent is too old to run the connector. Reinstall the agent on it, choose another node, or run the connector yourself.`
		);
	}
}

export async function get(ctx: Ctx, fetcher?: typeof fetch): Promise<PublicAccess> {
	requireInstallAdmin(ctx, 'see public access');
	const row = tunnelRow(ctx.db);
	if (!row) {
		const url = agentUrl(ctx.db, ctx.settings);
		return {
			agentUrl: url,
			source: ctx.settings.agentUrl || ctx.settings.publicUrl ? 'env' : 'browser',
			tunnel: null
		};
	}
	let status: TunnelStatus = 'unknown';
	try {
		const live = await cloudflare(ctx.secrets.decrypt(row.apiToken), fetcher).tunnelStatus(
			row.accountId,
			row.tunnelId
		);
		if (['healthy', 'degraded', 'down', 'inactive'].includes(live)) status = live as TunnelStatus;
	} catch {
		// the page still shows the tunnel; only its status is unknown
	}
	const nodeName = row.nodeId
		? (ctx.db.select({ name: node.name }).from(node).where(eq(node.id, row.nodeId)).get()?.name ??
			null)
		: null;
	return {
		agentUrl: `https://${row.hostname}`,
		source: 'tunnel',
		tunnel: {
			provider: row.provider,
			hostname: row.hostname,
			zoneName: row.zoneName,
			originUrl: row.originUrl,
			nodeId: row.nodeId,
			nodeName,
			status,
			connectorProblem: row.nodeId ? connectorProblem(ctx.db, row.nodeId) : null,
			createdAt: row.createdAt.toISOString()
		}
	};
}

/** The domains an API token can manage, to choose the tunnel's hostname from. */
export async function zones(
	ctx: Ctx,
	input: ListCloudflareZones,
	fetcher?: typeof fetch
): Promise<CloudflareZone[]> {
	requireInstallAdmin(ctx, 'set up public access');
	const list = await cloudflare(input.apiToken, fetcher).zones();
	if (!list.length) {
		throw new AppError(
			'validation_failed',
			'This API token can’t see any active domains. Give it DNS: Edit on the domain you want to use.'
		);
	}
	return list;
}

/**
 * Creates the tunnel, its routes and its DNS name, then hands the connector
 * to the chosen node. If a step fails, what was already created is removed.
 */
export async function create(ctx: Ctx, input: CreatePublicTunnel, fetcher?: typeof fetch) {
	requireInstallAdmin(ctx, 'set up public access');
	if (tunnelRow(ctx.db)) throw new AppError('conflict', 'This install already has a tunnel');
	requireNodeId(ctx.db, input.nodeId);

	const cf = cloudflare(input.apiToken, fetcher);
	const zone = await cf.zone(input.zoneId);
	const hostname = input.subdomain ? `${input.subdomain}.${zone.name}` : zone.name;
	if (await cf.dnsRecordExists(zone.id, hostname)) {
		throw new AppError(
			'conflict',
			`${hostname} already has a DNS record. Choose another name, or remove the record in Cloudflare first.`
		);
	}

	const name = `tramline-${hostname.replaceAll('.', '-')}-${randomBytes(3).toString('hex')}`;
	const tunnel = await cf.createTunnel(zone.accountId, name);
	let dnsRecordId: string | null = null;
	try {
		await cf.configureTunnel(zone.accountId, tunnel.id, ingressRules(hostname, input.originUrl));
		const token = await cf.tunnelToken(zone.accountId, tunnel.id);
		dnsRecordId = (await cf.createCname(zone.id, hostname, `${tunnel.id}.cfargotunnel.com`)).id;
		ctx.db
			.insert(publicTunnel)
			.values({
				id: newId('tunnel'),
				provider: 'cloudflare',
				hostname,
				apiToken: ctx.secrets.encrypt(input.apiToken),
				accountId: zone.accountId,
				zoneId: zone.id,
				zoneName: zone.name,
				tunnelId: tunnel.id,
				dnsRecordId,
				tunnelToken: ctx.secrets.encrypt(token),
				originUrl: input.originUrl,
				nodeId: input.nodeId,
				createdBy: ctx.userId
			})
			.run();
	} catch (error) {
		if (dnsRecordId) await cf.deleteDnsRecord(zone.id, dnsRecordId).catch(() => {});
		await cf.deleteTunnel(zone.accountId, tunnel.id).catch(() => {});
		throw error;
	}
	notifyNodes();
	return get(ctx, fetcher);
}

function requireTunnel(ctx: Ctx): Row {
	const row = tunnelRow(ctx.db);
	if (!row) throw notFound('Tunnel');
	return row;
}

/** Moves the connector to another node, or changes where it reaches this install. */
export async function update(ctx: Ctx, input: UpdatePublicTunnel, fetcher?: typeof fetch) {
	requireInstallAdmin(ctx, 'change public access');
	const row = requireTunnel(ctx);
	if (input.nodeId !== undefined) requireNodeId(ctx.db, input.nodeId);
	if (input.originUrl !== undefined && input.originUrl !== row.originUrl) {
		await cloudflare(ctx.secrets.decrypt(row.apiToken), fetcher).configureTunnel(
			row.accountId,
			row.tunnelId,
			ingressRules(row.hostname, input.originUrl)
		);
	}
	ctx.db
		.update(publicTunnel)
		.set({
			...(input.originUrl !== undefined ? { originUrl: input.originUrl } : {}),
			...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
			updatedAt: new Date()
		})
		.where(eq(publicTunnel.id, row.id))
		.run();
	notifyNodes();
	return get(ctx, fetcher);
}

/**
 * Deletes the DNS record and the tunnel in Cloudflare, then forgets them.
 * `force` forgets them even if Cloudflare can't be reached or the token was
 * revoked; they then have to be removed in Cloudflare by hand.
 */
export async function remove(ctx: Ctx, { force = false } = {}, fetcher?: typeof fetch) {
	requireInstallAdmin(ctx, 'change public access');
	const row = requireTunnel(ctx);
	try {
		const cf = cloudflare(ctx.secrets.decrypt(row.apiToken), fetcher);
		await cf.deleteDnsRecord(row.zoneId, row.dnsRecordId);
		await cf.deleteTunnel(row.accountId, row.tunnelId);
	} catch (error) {
		if (!force) throw error;
	}
	ctx.db.delete(publicTunnel).where(eq(publicTunnel.id, row.id)).run();
	notifyNodes();
}

/** The command for running the connector by hand, e.g. where no node has Docker. */
export function connector(ctx: Ctx): TunnelConnector {
	requireInstallAdmin(ctx, 'run the tunnel connector');
	const token = ctx.secrets.decrypt(requireTunnel(ctx).tunnelToken);
	return {
		token,
		command: `docker run -d --restart always --network host --name tramline-tunnel ${TUNNEL_IMAGE} tunnel --no-autoupdate run --token ${token}`
	};
}
