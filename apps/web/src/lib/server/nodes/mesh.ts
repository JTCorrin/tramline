import {
	DEFAULT_SERVICE_CONFIG,
	mergeConfig,
	type DesiredMesh,
	type MeshForward,
	type MeshLink,
	type MeshPeer,
	type TcpProxy
} from '@tramline/contracts';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Secrets } from '../crypto';
import type { DbOrTx } from '../db/client';
import { deployment, node, serviceInstance } from '../db/schema';
import { verifiedHostnames } from '../domain/domains';
import { deploymentAlias, networkName, RUNNING_STATUSES } from './names';
import { isOnline, MESH_CIDR, type NodeRow } from './registry';

/**
 * The mesh connects nodes over WireGuard. Each node runs a mesh container
 * with the tunnel in its own network namespace; services cross nodes one TCP
 * port at a time:
 *
 *   app ─▶ link (answers to postgres.production.tramline.internal on the
 *          environment's network) ─▶ mesh container ══ WireGuard ══▶ mesh
 *          container on the database's node ─▶ postgres:5432
 *
 * Links only join their own environment's network, so environments stay as
 * isolated from each other as they are on one node.
 */

export const MESH_LISTEN_PORT = 51820;
export const meshContainerName = (nodeId: string) => `tramline-mesh-${nodeId}`;
/**
 * The mesh container's name on the mesh network only. Its container name
 * would resolve to its address on any network it shares with the caller, but
 * it listens for forwards on the mesh network alone.
 */
export const meshAlias = (nodeId: string) => `${nodeId}.mesh.tramline.internal`;
/** The network between a node's mesh container, its links and its ingress. */
export const meshNetworkName = (nodeId: string) => `tl-mesh-${nodeId}`;
export const linkName = (environmentId: string, serviceId: string) =>
	`tl-link-${environmentId}-${serviceId}`;

/** A service's port that other nodes can reach. */
export interface MeshExport {
	serviceId: string;
	environmentId: string;
	nodeId: string;
	port: number;
	/** e.g. `postgres.production.tramline.internal`, as the service's deployment saw it. */
	alias: string;
	/**
	 * Where the mesh delivers on the service's node: the chosen deployment's own
	 * alias, so traffic from other nodes only moves once a new deployment is live.
	 */
	target: string;
	/** Public hostnames of its live deployment, which edge nodes serve. */
	hosts: { host: string; custom: boolean }[];
	/** Its TCP proxy, which edge nodes publish: the edge port and who may connect. */
	tcp: { port: number; allow: string[] } | null;
}

const FIRST_PORT = 20_000;
const PORTS = 40_000;

/**
 * Each exported service gets the same port on every node, from a hash of its
 * service and environment, so adding a service never moves another one.
 * Collisions take the next free port, in a fixed order.
 */
export function meshPorts(exports: Pick<MeshExport, 'serviceId' | 'environmentId'>[]) {
	const keys = [...new Set(exports.map((e) => `${e.environmentId}:${e.serviceId}`))].sort();
	const ports = new Map<string, number>();
	const used = new Set<number>();
	for (const key of keys) {
		const hash = createHash('sha256').update(key).digest().readUInt32BE(0);
		let port = FIRST_PORT + (hash % PORTS);
		while (used.has(port)) port = FIRST_PORT + ((port - FIRST_PORT + 1) % PORTS);
		used.add(port);
		ports.set(key, port);
	}
	return ports;
}

interface Member {
	id: string;
	name: string;
	address: string;
	publicKey: string;
	endpoint: string | null;
}

/** How one node reaches each other member: directly, through a relay, or not at all. */
export function routes(members: Member[], self: Member) {
	// the first node anyone can reach relays between nodes that can't reach each other
	const relay = members.find((m) => m.endpoint);
	const direct = new Map<string, string[]>();
	const relayed: { node: Member; via: Member }[] = [];
	const unreachable: Member[] = [];
	for (const other of members) {
		if (other.id === self.id) continue;
		if (self.endpoint || other.endpoint) {
			direct.set(other.id, [...(direct.get(other.id) ?? []), `${other.address}/32`]);
		} else if (relay && relay.id !== self.id && relay.id !== other.id) {
			direct.set(relay.id, [...(direct.get(relay.id) ?? []), `${other.address}/32`]);
			relayed.push({ node: other, via: relay });
		} else unreachable.push(other);
	}
	const natPairs = members.some((a) =>
		members.some((b) => a.id < b.id && !a.endpoint && !b.endpoint)
	);
	return { direct, relayed, unreachable, relays: !!relay && relay.id === self.id && natPairs };
}

/** Nodes that can be in the mesh: online, with a key and an address. */
export function meshMembers(db: DbOrTx, now = Date.now()): Member[] {
	return db
		.select()
		.from(node)
		.where(and(isNotNull(node.meshPublicKey), isNotNull(node.meshAddress)))
		.orderBy(asc(node.createdAt), asc(node.id))
		.all()
		.filter((row: NodeRow) => isOnline(row, now))
		.map((row) => ({
			id: row.id,
			name: row.name,
			address: row.meshAddress!,
			publicKey: row.meshPublicKey!,
			endpoint: row.meshEndpoint
		}));
}

/**
 * Services with a port, and the node each runs on. While a service moves
 * between nodes its live deployment's node wins, so traffic only switches
 * once the new one is healthy.
 */
export function meshExports(db: DbOrTx, secrets: Secrets): MeshExport[] {
	const hostnames = verifiedHostnames(db);
	const rows = db
		.select({ deployment, domain: serviceInstance.domain, tcpPort: serviceInstance.tcpPort })
		.from(deployment)
		.innerJoin(
			serviceInstance,
			and(
				eq(serviceInstance.serviceId, deployment.serviceId),
				eq(serviceInstance.environmentId, deployment.environmentId)
			)
		)
		.where(and(isNotNull(deployment.nodeId), inArray(deployment.status, [...RUNNING_STATUSES])))
		.orderBy(asc(deployment.createdAt), asc(deployment.id))
		.all();
	const chosen = new Map<string, (typeof rows)[number]>();
	for (const row of rows) {
		const key = `${row.deployment.environmentId}:${row.deployment.serviceId}`;
		const current = chosen.get(key);
		const live = (s: string) => s === 'active' || s === 'crashed';
		// later rows are newer; a live deployment beats one still deploying
		if (!current || live(row.deployment.status) || !live(current.deployment.status)) {
			chosen.set(key, row);
		}
	}
	return [...chosen.values()].flatMap(({ deployment: dep, domain, tcpPort }) => {
		const config = mergeConfig(DEFAULT_SERVICE_CONFIG, dep.config);
		if (!config.networking.port || config.deploy.cronSchedule) return [];
		const env = JSON.parse(secrets.decrypt(dep.variables)) as Record<string, string>;
		if (!env.TRAMLINE_PRIVATE_DOMAIN) return [];
		// as on one node, public traffic only goes to a live deployment
		const live = dep.status === 'active' || dep.status === 'crashed';
		const hosts = live
			? [
					...(domain && config.networking.publicDomain ? [{ host: domain, custom: false }] : []),
					...(hostnames.get(`${dep.serviceId}:${dep.environmentId}`) ?? []).map((d) => ({
						host: d.hostname,
						custom: true
					}))
				]
			: [];
		return [
			{
				serviceId: dep.serviceId,
				environmentId: dep.environmentId,
				nodeId: dep.nodeId!,
				port: config.networking.port,
				alias: env.TRAMLINE_PRIVATE_DOMAIN,
				target: deploymentAlias(dep.id),
				tcp:
					live && tcpPort && config.networking.tcpProxy && config.networking.tcpAllowlist.length
						? { port: tcpPort, allow: config.networking.tcpAllowlist }
						: null,
				hosts
			}
		];
	});
}

/**
 * One node's part of the mesh. `networks` are the environment networks it
 * runs containers on; an edge node also forwards to every public service.
 */
export function planMesh(
	members: Member[],
	exports: MeshExport[],
	self: { id: string; edge: boolean; networks: string[] }
): DesiredMesh | null {
	const me = members.find((m) => m.id === self.id);
	if (!me || members.length < 2) return null;
	const { direct, relays } = routes(members, me);
	const reachable = new Set<string>(
		[...direct.values()].flat().map((cidr) => members.find((m) => `${m.address}/32` === cidr)!.id)
	);

	const peers: MeshPeer[] = [...direct.entries()].map(([id, allowedIps]) => {
		const peer = members.find((m) => m.id === id)!;
		return {
			nodeId: id,
			publicKey: peer.publicKey,
			endpoint: peer.endpoint,
			allowedIps: allowedIps.sort(),
			keepalive: !me.endpoint
		};
	});

	const ports = meshPorts(exports);
	const networks = new Set(self.networks);
	const forwards: MeshForward[] = [];
	const links: MeshLink[] = [];
	for (const e of exports) {
		const port = ports.get(`${e.environmentId}:${e.serviceId}`)!;
		const network = networkName(e.environmentId);
		if (e.nodeId === self.id) {
			forwards.push({ to: 'local', port, target: `${e.target}:${e.port}`, network });
			continue;
		}
		const host = members.find((m) => m.id === e.nodeId);
		if (!host || !reachable.has(host.id)) continue;
		const consumed = networks.has(network);
		if (!consumed && !(self.edge && (e.hosts.length || e.tcp))) continue;
		forwards.push({ to: 'remote', port, address: host.address });
		if (consumed) {
			links.push({
				name: linkName(e.environmentId, e.serviceId),
				network,
				alias: e.alias,
				port: e.port,
				meshPort: port
			});
		}
	}
	forwards.sort((a, b) => a.port - b.port);
	links.sort((a, b) => a.name.localeCompare(b.name));

	return {
		address: me.address,
		cidr: MESH_CIDR,
		listenPort: MESH_LISTEN_PORT,
		relay: relays,
		peers: peers.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
		forwards,
		links
	};
}

export const tcpProxyName = (environmentId: string, serviceId: string) =>
	`tl-tcp-${environmentId}-${serviceId}`;

/**
 * The TCP proxies an edge node publishes: to the service's own deployment
 * when it runs here, otherwise through this node's mesh container.
 */
export function planTcpProxies(
	exports: MeshExport[],
	self: { id: string; edge: boolean },
	mesh: DesiredMesh | null
): TcpProxy[] {
	if (!self.edge) return [];
	const ports = meshPorts(exports);
	const forwarded = new Set(mesh?.forwards.filter((f) => f.to === 'remote').map((f) => f.port));
	return exports.flatMap((e) => {
		if (!e.tcp) return [];
		const base = {
			name: tcpProxyName(e.environmentId, e.serviceId),
			port: e.tcp.port,
			protocol: 'postgres' as const,
			allow: e.tcp.allow
		};
		if (e.nodeId === self.id) {
			return [{ ...base, target: `${e.target}:${e.port}`, network: networkName(e.environmentId) }];
		}
		const meshPort = ports.get(`${e.environmentId}:${e.serviceId}`)!;
		if (!forwarded.has(meshPort)) return [];
		return [
			{
				...base,
				target: `${meshAlias(self.id)}:${meshPort}`,
				network: meshNetworkName(self.id)
			}
		];
	});
}
