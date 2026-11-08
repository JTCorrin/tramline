import {
	cloudInit,
	mergeCredentials,
	publicCredentials,
	type ComputeAdapter
} from '@tramline/adapter-sdk';
import type {
	AdapterAccount,
	AdapterOffer,
	AdapterRegion,
	CreateAdapterAccount,
	LeftoverMachine,
	ProvisioningNode,
	ProvisionNode,
	UpdateAdapterAccount
} from '@tramline/contracts';
import { ProvisionNode as ProvisionSchema } from '@tramline/contracts';
import { and, asc, count, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AppError, notFound } from '../api/errors';
import { getAdapter } from '../adapters/registry';
import type { DbOrTx } from '../db/client';
import { adapterAccount, joinToken, node, nodePool, type OfferGpu } from '../db/schema';
import { newId } from '../ids';
import { hashToken } from '../nodes/registry';
import { requireInstallAdmin } from './admins';
import type { Ctx } from './context';
import { issueJoinToken } from './nodes';

/**
 * Adapter accounts: connections to Proxmox or a cloud that create machines.
 * They belong to the install, like nodes, so only install admins manage
 * them. Credentials are kept encrypted as one JSON object; secret fields are
 * never sent back.
 */

export type Row = typeof adapterAccount.$inferSelect;

function requireAdapter(id: string) {
	const adapter = getAdapter(id);
	if (!adapter)
		throw new AppError('validation_failed', `There is no ${id} adapter on this install`);
	if (id === 'manual') {
		throw new AppError('validation_failed', 'Machines you enroll yourself need no account');
	}
	return adapter;
}

export function requireAccount(ctx: Pick<Ctx, 'db'>, id: string) {
	const row = ctx.db.select().from(adapterAccount).where(eq(adapterAccount.id, id)).get();
	if (!row) throw notFound('Account');
	return row;
}

const decrypt = (ctx: Pick<Ctx, 'secrets'>, row: Row) =>
	JSON.parse(ctx.secrets.decrypt(row.credentials)) as Record<string, unknown>;

/** Nodes an account created: enrolled, or still waiting to. */
function usage(db: DbOrTx, accountId: string) {
	const nodes = db
		.select({ n: count() })
		.from(node)
		.where(eq(node.adapterAccountId, accountId))
		.get()!.n;
	const waiting = db
		.select({ n: count() })
		.from(joinToken)
		.where(and(eq(joinToken.adapterAccountId, accountId), isNull(joinToken.usedAt)))
		.get()!.n;
	return nodes + waiting;
}

function toDto(ctx: Ctx, row: Row): AdapterAccount {
	const adapter = getAdapter(row.adapter);
	const creds = decrypt(ctx, row);
	return {
		id: row.id,
		adapter: row.adapter,
		name: row.name,
		// an adapter no longer installed: show nothing rather than guess what's secret
		credentials: adapter ? publicCredentials(adapter.credentials, creds) : {},
		nodes: usage(ctx.db, row.id),
		createdAt: row.createdAt.toISOString()
	};
}

function nameTaken(ctx: Ctx, name: string, except?: string) {
	const row = ctx.db
		.select({ id: adapterAccount.id })
		.from(adapterAccount)
		.where(eq(adapterAccount.name, name))
		.get();
	return !!row && row.id !== except;
}

export function listAccounts(ctx: Ctx): AdapterAccount[] {
	requireInstallAdmin(ctx, 'see compute accounts');
	return ctx.db
		.select()
		.from(adapterAccount)
		.orderBy(asc(adapterAccount.createdAt))
		.all()
		.map((row) => toDto(ctx, row));
}

export function createAccount(ctx: Ctx, input: CreateAdapterAccount): AdapterAccount {
	requireInstallAdmin(ctx, 'connect compute accounts');
	const adapter = requireAdapter(input.adapter);
	if (nameTaken(ctx, input.name)) {
		throw new AppError('conflict', `There is already an account called ${input.name}`);
	}
	const creds = mergeCredentials(adapter.credentials, input.credentials, null);
	const row = ctx.db
		.insert(adapterAccount)
		.values({
			id: newId('adapterAccount'),
			adapter: adapter.meta.id,
			name: input.name,
			credentials: ctx.secrets.encrypt(JSON.stringify(creds)),
			createdBy: ctx.userId
		})
		.returning()
		.get();
	return toDto(ctx, row);
}

/** Renames an account or changes its credentials; secret fields left blank keep their value. */
export function updateAccount(ctx: Ctx, id: string, input: UpdateAdapterAccount): AdapterAccount {
	requireInstallAdmin(ctx, 'change compute accounts');
	const row = requireAccount(ctx, id);
	const changes: Partial<Row> = {};
	if (input.name !== undefined && input.name !== row.name) {
		if (nameTaken(ctx, input.name, id)) {
			throw new AppError('conflict', `There is already an account called ${input.name}`);
		}
		changes.name = input.name;
	}
	if (input.credentials) {
		const adapter = requireAdapter(row.adapter);
		const creds = mergeCredentials(adapter.credentials, input.credentials, decrypt(ctx, row));
		changes.credentials = ctx.secrets.encrypt(JSON.stringify(creds));
	}
	const updated = Object.keys(changes).length
		? ctx.db.update(adapterAccount).set(changes).where(eq(adapterAccount.id, id)).returning().get()!
		: row;
	return toDto(ctx, updated);
}

/** Refused while the account has nodes: removing them is what destroys their machines. */
export function removeAccount(ctx: Ctx, id: string) {
	requireInstallAdmin(ctx, 'remove compute accounts');
	const row = requireAccount(ctx, id);
	const pool = ctx.db
		.select({ name: nodePool.name })
		.from(nodePool)
		.where(eq(nodePool.adapterAccountId, id))
		.get();
	if (pool) {
		throw new AppError(
			'conflict',
			`The node pool ${pool.name} uses ${row.name}. Remove the pool first.`
		);
	}
	const used = usage(ctx.db, id);
	if (used) {
		throw new AppError(
			'conflict',
			`${row.name} still has ${used} node${used === 1 ? '' : 's'}. Remove ${used === 1 ? 'it' : 'them'} first, so ${used === 1 ? 'its machine is' : 'their machines are'} destroyed.`
		);
	}
	ctx.db.transaction((tx) => {
		// join tokens it used long ago keep no link to it
		tx.update(joinToken)
			.set({ adapterAccountId: null })
			.where(eq(joinToken.adapterAccountId, id))
			.run();
		tx.delete(adapterAccount).where(eq(adapterAccount.id, id)).run();
	});
}

/** An account's adapter, with its credentials decrypted and checked. */
export function connect(ctx: Pick<Ctx, 'secrets'>, row: Row) {
	const adapter = getAdapter(row.adapter);
	if (!adapter) {
		throw new AppError(
			'conflict',
			`${row.name} uses the ${row.adapter} adapter, which this install no longer has`
		);
	}
	return { adapter, creds: adapter.credentials.parse(decrypt(ctx, row)) };
}

/** Runs an adapter call, turning its failure into a message about the account. */
export async function call<T>(row: Row, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof AppError) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		throw new AppError('conflict', `${row.name}: ${reason}`);
	}
}

/** "Test connection": the adapter checks the credentials against the provider. */
export async function testAccount(ctx: Ctx, id: string) {
	requireInstallAdmin(ctx, 'test compute accounts');
	const row = requireAccount(ctx, id);
	const { adapter, creds } = connect(ctx, row);
	await call(row, () => adapter.validate(creds));
	return { ok: true };
}

export async function regions(ctx: Ctx, id: string): Promise<AdapterRegion[]> {
	requireInstallAdmin(ctx, 'add nodes');
	const row = requireAccount(ctx, id);
	const { adapter, creds } = connect(ctx, row);
	return call(row, () => adapter.listRegions(creds));
}

export async function offers(ctx: Ctx, id: string, region: string): Promise<AdapterOffer[]> {
	requireInstallAdmin(ctx, 'add nodes');
	const row = requireAccount(ctx, id);
	const { adapter, creds } = connect(ctx, row);
	return call(row, () => adapter.listOffers(creds, region));
}

/**
 * Has an account's adapter create a machine that enrolls itself with a new
 * join token. The node appears once its agent joins; until then it's listed
 * as provisioning. If the adapter fails, the token goes too.
 */
export async function provision(ctx: Ctx, input: ProvisionNode, origin: string) {
	requireInstallAdmin(ctx, 'add nodes');
	const parsed = ProvisionSchema.parse(input);
	const row = requireAccount(ctx, parsed.account);
	return provisionMachine(ctx, row, parsed, origin);
}

/** `provision` without the permission check, for node pools growing by themselves. */
export async function provisionMachine(
	ctx: Ctx,
	row: Row,
	machine: {
		name: string;
		region: string;
		offer: string;
		cordoned: boolean;
		poolId?: string;
		/** The size's GPUs, when the caller knows them; looked up otherwise. */
		gpu?: OfferGpu | null;
	},
	origin: string
) {
	const { adapter, creds } = connect(ctx, row);
	// the driver won't say how much memory a GPU has, so it's kept from the size
	const gpu =
		machine.gpu !== undefined
			? machine.gpu
			: adapter.capabilities.gpus
				? await call(row, () => adapter.listOffers(creds, machine.region))
						.then((offers) => offers.find((o) => o.id === machine.offer)?.gpu ?? null)
						.catch(() => null)
				: null;
	const joining = issueJoinToken(ctx, { name: machine.name, cordoned: machine.cordoned }, origin, {
		adapterAccountId: row.id,
		region: machine.region,
		offer: machine.offer,
		offerGpu: gpu,
		...(machine.poolId ? { poolId: machine.poolId } : {})
	});
	const { id: tokenId, url } = joining;
	const userData = cloudInit({ url, token: joining.token });
	const seedId = randomBytes(24).toString('base64url');
	ctx.db
		.update(joinToken)
		.set({ seedHash: hashToken(seedId), seed: ctx.secrets.encrypt(userData) })
		.where(eq(joinToken.id, tokenId))
		.run();
	try {
		const created = await call(row, () =>
			adapter.createNode(creds, {
				name: machine.name,
				region: machine.region,
				offer: machine.offer,
				install: { url, token: joining.token, command: joining.command },
				userData,
				seedUrl: `${url}/api/agent/v1/seed/${seedId}/`
			})
		);
		const token = ctx.db
			.update(joinToken)
			.set({ providerNodeId: created.id })
			.where(eq(joinToken.id, tokenId))
			.returning({ nodeId: joinToken.nodeId })
			.get();
		// it may have enrolled before the adapter answered
		if (token?.nodeId) {
			ctx.db
				.update(node)
				.set({ providerNodeId: created.id })
				.where(eq(node.id, token.nodeId))
				.run();
		}
		return { id: tokenId, name: machine.name, expiresAt: joining.expiresAt, machine: created };
	} catch (error) {
		ctx.db.delete(joinToken).where(eq(joinToken.id, tokenId)).run();
		throw error;
	}
}

/**
 * A file of a machine's cloud-init NoCloud seed, for adapters that hand it
 * a URL (Proxmox). Only while its join token can still be used: the user
 * data holds that token. The seed ID is the only credential.
 */
export function seedFile(
	db: DbOrTx,
	secrets: Pick<Ctx['secrets'], 'decrypt'>,
	seedId: string,
	file: string,
	now = new Date()
) {
	const token = db
		.select()
		.from(joinToken)
		.where(
			and(
				eq(joinToken.seedHash, hashToken(seedId)),
				isNull(joinToken.usedAt),
				gt(joinToken.expiresAt, now)
			)
		)
		.get();
	if (!token?.seed) return null;
	if (file === 'user-data') return secrets.decrypt(token.seed);
	// instance-id is required; a new one per machine makes cloud-init run its user data
	if (file === 'meta-data')
		return `instance-id: ${token.id}\nlocal-hostname: ${JSON.stringify(token.name)}\n`;
	// cloud-init asks for vendor data too; there is none
	if (file === 'vendor-data') return '';
	return null;
}

/** Machines adapters created that haven't enrolled, including ones whose token expired. */
export function provisioning(ctx: Ctx, now = new Date()): ProvisioningNode[] {
	requireInstallAdmin(ctx, 'see nodes being added');
	return ctx.db
		.select({ token: joinToken, account: adapterAccount })
		.from(joinToken)
		.innerJoin(adapterAccount, eq(adapterAccount.id, joinToken.adapterAccountId))
		.where(and(isNull(joinToken.usedAt), isNotNull(joinToken.adapterAccountId)))
		.orderBy(asc(joinToken.createdAt))
		.all()
		.map(({ token, account }) => ({
			id: token.id,
			name: token.name,
			account: { id: account.id, name: account.name, adapter: account.adapter },
			machine: token.providerNodeId,
			region: token.region,
			offer: token.offer,
			expiresAt: token.expiresAt.toISOString(),
			expired: token.expiresAt <= now,
			createdAt: token.createdAt.toISOString()
		}));
}

/** Destroys a machine that hasn't enrolled (or never will), and its join token. */
export async function cancelProvisioning(ctx: Ctx, id: string) {
	requireInstallAdmin(ctx, 'cancel nodes being added');
	const token = ctx.db
		.select()
		.from(joinToken)
		.where(
			and(eq(joinToken.id, id), isNull(joinToken.usedAt), isNotNull(joinToken.adapterAccountId))
		)
		.get();
	if (!token) throw notFound('Node being added');
	await destroyPending(ctx, token);
}

/** Destroys a machine that hasn't enrolled, then forgets its join token. */
export async function destroyPending(ctx: Ctx, token: typeof joinToken.$inferSelect) {
	const row = requireAccount(ctx, token.adapterAccountId!);
	if (token.providerNodeId) {
		const { adapter, creds } = connect(ctx, row);
		await call(row, () => adapter.destroyNode(creds, token.providerNodeId!));
	}
	ctx.db.delete(joinToken).where(eq(joinToken.id, token.id)).run();
}

/**
 * Machines an account's provider runs with Tramline's tag that no node, and
 * no machine still enrolling, accounts for: left over from a failed create,
 * a database restored from an older backup, or another install using the
 * same account.
 */
export async function leftovers(ctx: Ctx, id: string): Promise<LeftoverMachine[]> {
	requireInstallAdmin(ctx, 'look for leftover machines');
	return (await unclaimed(ctx, requireAccount(ctx, id))).map((m) => ({
		id: m.id,
		name: m.name,
		region: m.region,
		status: m.status,
		address: m.address
	}));
}

/** `leftovers` without the permission check. */
async function unclaimed(ctx: Ctx, row: Row) {
	const { adapter, creds } = connect(ctx, row);
	if (!adapter.capabilities.inventory) return [];
	const machines = await call(row, () => adapter.listNodes(creds));
	const known = new Set([
		...ctx.db
			.select({ id: node.providerNodeId })
			.from(node)
			.where(eq(node.adapterAccountId, row.id))
			.all()
			.map((n) => n.id),
		...ctx.db
			.select({ id: joinToken.providerNodeId })
			.from(joinToken)
			.where(and(eq(joinToken.adapterAccountId, row.id), isNull(joinToken.usedAt)))
			.all()
			.map((t) => t.id)
	]);
	return machines.filter((m) => !known.has(m.id));
}

/**
 * Whether a provider's machine name is how it spells this node's name:
 * lowercased, other characters as hyphens, `tl-` before a leading digit, and
 * cut short where the provider limits names (Azure at 50 characters).
 */
export function namedFor(machine: string, nodeName: string) {
	const spell = (name: string) =>
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '');
	const want = spell(nodeName);
	const got = spell(machine).replace(/^tl-(?=\d)/, '');
	return got === want || (got.length >= 40 && want.startsWith(got));
}

/**
 * The provider's ID for the machine behind a node, or null when it has none.
 * It's recorded once the adapter finishes creating the machine; if Tramline
 * restarted before that, the node can still enroll without it, so it's found
 * again among the account's unclaimed machines by name, and recorded.
 */
async function machineOf(ctx: Ctx, row: Row, target: typeof node.$inferSelect) {
	if (target.providerNodeId) return target.providerNodeId;
	const matches = (await unclaimed(ctx, row)).filter((m) => namedFor(m.name, target.name));
	if (matches.length > 1) {
		throw new AppError(
			'conflict',
			`Tramline didn't record which machine is ${target.name}'s, and ${matches.length} machines on ${row.name} match its name. Destroy the right one under Compute accounts → Find leftovers, then remove the node again.`
		);
	}
	const id = matches[0]?.id ?? null;
	if (id) ctx.db.update(node).set({ providerNodeId: id }).where(eq(node.id, target.id)).run();
	return id;
}

/** Destroys a leftover machine; only one `leftovers` would list, never a node's. */
export async function destroyLeftover(ctx: Ctx, id: string, machineId: string) {
	const found = await leftovers(ctx, id);
	if (!found.some((m) => m.id === machineId)) throw notFound('Leftover machine');
	const row = requireAccount(ctx, id);
	const { adapter, creds } = connect(ctx, row);
	await call(row, () => adapter.destroyNode(creds, machineId));
}

/** An adapter that opens and closes edge nodes' TCP 80 and 443 itself. */
export const opensEdgePorts = (adapter: ComputeAdapter | undefined) =>
	!!adapter?.capabilities.edgePorts && typeof adapter.setEdge === 'function';

/**
 * Opens (or closes) TCP 80 and 443 to the machine behind a node an adapter
 * created, before the node becomes (or stops being) an edge node. Nodes
 * whose adapter can't, enrolled by hand say, are left to the person.
 */
export async function setMachineEdge(ctx: Ctx, target: typeof node.$inferSelect, open: boolean) {
	if (!target.adapterAccountId) return;
	const row = requireAccount(ctx, target.adapterAccountId);
	const { adapter, creds } = connect(ctx, row);
	if (!opensEdgePorts(adapter)) return;
	const machine = await machineOf(ctx, row, target);
	if (!machine) return;
	await call(row, () => (adapter as ComputeAdapter).setEdge!(creds, machine, open)).catch(
		(error: AppError) => {
			throw new AppError(
				'conflict',
				open
					? `Couldn't open TCP 80 and 443 on ${target.name}, so it isn't an edge node. ${error.message}`
					: `Couldn't close TCP 80 and 443 on ${target.name}, so it's still an edge node. ${error.message}`
			);
		}
	);
}

/**
 * Destroys the machine behind a node an adapter created, before the node is
 * forgotten. Nodes enrolled by hand have nothing to destroy.
 */
export async function destroyMachine(ctx: Ctx, target: typeof node.$inferSelect) {
	if (!target.adapterAccountId) return;
	const row = requireAccount(ctx, target.adapterAccountId);
	const { adapter, creds } = connect(ctx, row);
	const machine = await machineOf(ctx, row, target).catch((error: AppError) => {
		throw new AppError(
			'conflict',
			`Couldn't destroy ${target.name}'s machine, so the node was kept. ${error.message}`
		);
	});
	// gone already, or never made it: nothing to destroy
	if (!machine) return;
	await call(row, () => (adapter as ComputeAdapter).destroyNode(creds, machine)).catch(
		(error: AppError) => {
			throw new AppError(
				'conflict',
				`Couldn't destroy ${target.name}'s machine, so the node was kept. ${error.message}`
			);
		}
	);
}
