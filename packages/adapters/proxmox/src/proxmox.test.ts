import { conformance, type NodeSpec } from '@tramline/adapter-sdk';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server, type ServerOptions } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProxmoxClient } from './client';
import { proxmoxAdapter, type ProxmoxCredentials } from './index';

/**
 * A fake Proxmox VE API, served over real HTTPS with a self-signed
 * certificate, so the adapter's own client (and its pinning) is what's tested.
 */

const TOKEN = 'tramline@pve!tramline';
const SECRET = '11111111-2222-3333-4444-555555555555';

interface Vm {
	vmid: number;
	name: string;
	node: string;
	status: 'running' | 'stopped';
	template: number;
	tags: string;
	config: Record<string, string>;
	type: 'qemu';
	/** What cluster/resources reports, when it lags behind the VM's own status */
	listed?: 'running' | 'stopped';
}

let vms: Vm[];
let failNext: string | null;
let taskStatus: { status: string; exitstatus?: string };
let requests: string[];

function reset() {
	vms = [
		{
			vmid: 9000,
			name: 'debian-cloud',
			node: 'pve1',
			status: 'stopped',
			template: 1,
			tags: '',
			config: { smbios1: 'uuid=7a0b7e4e-1111-2222-3333-444455556666,manufacturer=QEMU' },
			type: 'qemu'
		},
		{
			vmid: 100,
			name: 'someone-elses-vm',
			node: 'pve1',
			status: 'running',
			template: 0,
			tags: 'prod',
			config: {},
			type: 'qemu'
		}
	];
	failNext = null;
	taskStatus = { status: 'stopped', exitstatus: 'OK' };
	requests = [];
}

async function handle(method: string, url: URL, form: URLSearchParams) {
	const p = url.pathname.replace(/^\/api2\/json\//, '');
	const task = (node: string) => `UPID:${node}:0000:task-${requests.length}:`;
	if (method === 'GET' && p === 'version') return { version: '8.2.4' };
	if (method === 'GET' && p === 'nodes') {
		return [
			{ node: 'pve2', status: 'online', maxcpu: 4, maxmem: 8 * 1024 ** 3 },
			{ node: 'pve1', status: 'online', maxcpu: 16, maxmem: 64 * 1024 ** 3 },
			{ node: 'pve3', status: 'offline' }
		];
	}
	if (method === 'GET' && p === 'cluster/resources') {
		return vms.map(({ config: _config, listed, ...vm }) => ({
			...vm,
			status: listed ?? vm.status
		}));
	}
	if (method === 'GET' && p === 'cluster/nextid') {
		// like Proxmox: the lowest free ID from 100
		let id = 100;
		while (vms.some((v) => v.vmid === id)) id++;
		return String(id);
	}
	if (method === 'GET' && /^nodes\/[^/]+\/tasks\/[^/]+\/status$/.test(p)) {
		return taskStatus;
	}
	let m = p.match(/^nodes\/([^/]+)\/qemu\/(\d+)\/clone$/);
	if (method === 'POST' && m) {
		const source = vms.find((v) => v.vmid === Number(m![2]))!;
		vms.push({
			vmid: Number(form.get('newid')),
			name: form.get('name')!,
			node: form.get('target') ?? m[1]!,
			status: 'stopped',
			template: 0,
			tags: '',
			config: { ...source.config, smbios1: 'uuid=9f00c0de-0000-1111-2222-333344445555' },
			type: 'qemu'
		});
		return task(m[1]!);
	}
	m = p.match(/^nodes\/([^/]+)\/qemu\/(\d+)(\/.*)?$/);
	const vm = m && vms.find((v) => v.vmid === Number(m![2]) && v.node === m![1]);
	if (m && !vm) throw Object.assign(new Error('no such VM'), { status: 500 });
	if (vm && m![3] === '/config' && method === 'GET') return vm.config;
	if (vm && m![3] === '/config' && method === 'PUT') {
		for (const key of ['cores', 'memory', 'smbios1', 'tags', 'agent', 'onboot']) {
			const value = form.get(key);
			if (value !== null) vm.config[key] = value;
		}
		if (form.get('tags')) vm.tags = form.get('tags')!;
		return null;
	}
	if (vm && m![3] === '/status/current' && method === 'GET') return { status: vm.status };
	if (vm && m![3] === '/status/start' && method === 'POST') {
		vm.status = 'running';
		return task(vm.node);
	}
	if (vm && m![3] === '/status/stop' && method === 'POST') {
		vm.status = 'stopped';
		return task(vm.node);
	}
	if (vm && m![3] === undefined && method === 'DELETE') {
		vms = vms.filter((v) => v !== vm);
		return task(vm.node);
	}
	throw Object.assign(new Error(`unexpected ${method} ${p}`), { status: 501 });
}

let server: Server;
let fingerprint: string;
let caCertificate: string;
let validContext: ServerOptions;
let wrongHostContext: ServerOptions;
let wrongHostCertificate: string;
let url: string;

beforeAll(async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'tramline-pve-'));
	execFileSync(
		'openssl',
		['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'].concat([
			'-keyout',
			path.join(dir, 'key.pem'),
			'-out',
			path.join(dir, 'cert.pem'),
			'-days',
			'1',
			'-subj',
			'/CN=pve.test',
			'-addext',
			'subjectAltName=IP:127.0.0.1,DNS:localhost'
		]),
		{ stdio: 'ignore' }
	);
	const cert = readFileSync(path.join(dir, 'cert.pem'));
	fingerprint = new X509Certificate(cert).fingerprint256;
	caCertificate = cert.toString();
	validContext = { key: readFileSync(path.join(dir, 'key.pem')), cert };
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-key',
			path.join(dir, 'key.pem'),
			'-out',
			path.join(dir, 'wrong.pem'),
			'-days',
			'1',
			'-subj',
			'/CN=wrong.test'
		],
		{ stdio: 'ignore' }
	);
	wrongHostCertificate = readFileSync(path.join(dir, 'wrong.pem'), 'utf8');
	wrongHostContext = { key: validContext.key, cert: wrongHostCertificate };
	server = createServer(validContext, (req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', async () => {
			const target = new URL(req.url!, 'https://pve.test');
			requests.push(`${req.method} ${target.pathname}`);
			if (req.headers.authorization !== `PVEAPIToken=${TOKEN}=${SECRET}`) {
				res.writeHead(401, 'authentication failure').end('{"data":null}');
				return;
			}
			if (failNext && target.pathname.endsWith(failNext)) {
				failNext = null;
				res.writeHead(403, 'Permission check failed (/vms/101, VM.Config.Options)').end();
				return;
			}
			try {
				const data = await handle(
					req.method!,
					target,
					new URLSearchParams(Buffer.concat(chunks).toString())
				);
				res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
			} catch (error) {
				const status = (error as { status?: number }).status ?? 500;
				res
					.writeHead(status, (error as Error).message)
					.end(JSON.stringify({ data: null, errors: { vmid: (error as Error).message } }));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(reset);

const adapter = proxmoxAdapter({ pollMs: 1 });
const creds = (patch: Partial<ProxmoxCredentials> = {}): ProxmoxCredentials => ({
	url,
	tokenId: TOKEN,
	tokenSecret: SECRET,
	fingerprint,
	caCertificate,
	template: 9000,
	monthlyCost: 73,
	...patch
});

const spec = (patch: Partial<NodeSpec> = {}): NodeSpec => ({
	name: 'pve-node',
	region: 'pve1',
	offer: 'medium',
	install: { url: 'https://t.test', token: 'tljoin_x', command: 'curl …' },
	userData: '#cloud-config',
	seedUrl: 'https://t.test/api/agent/v1/seed/abc/',
	...patch
});

describe('the Proxmox adapter', () => {
	it('passes the conformance suite', async () => {
		const steps = await conformance(adapter, {
			credentials: creds(),
			invalidCredentials: creds({ tokenSecret: 'wrong' }),
			region: 'pve1',
			offer: 'small',
			pollMs: 1
		});
		expect(steps).toContain('no orphans');
		expect(vms.map((v) => v.vmid)).toEqual([9000, 100]);
	});

	it('clones the template, sizes the VM, points cloud-init at its seed and starts it', async () => {
		const node = await adapter.createNode(creds(), spec());
		expect(node).toMatchObject({ id: '101', region: 'pve1', status: 'provisioning' });
		const vm = vms.find((v) => v.vmid === 101)!;
		expect(vm).toMatchObject({ name: 'pve-node', status: 'running', tags: 'tramline' });
		expect(vm.config).toMatchObject({ cores: '4', memory: '8192', onboot: '1' });
		// the clone's own UUID is kept, and the serial carries the seed URL, base64-encoded
		const smbios = vm.config.smbios1!;
		expect(smbios).toMatch(/^uuid=9f00c0de-0000-1111-2222-333344445555,base64=1,serial=/);
		const serial = Buffer.from(smbios.split('serial=')[1]!, 'base64').toString();
		expect(serial).toBe('ds=nocloud;s=https://t.test/api/agent/v1/seed/abc/');
		expect(await adapter.listNodes(creds())).toEqual([expect.objectContaining({ id: '101' })]);
	});

	it('clones across hosts with a target, and offers only sizes a host can fit, priced by its share', async () => {
		await adapter.createNode(creds(), spec({ region: 'pve2', offer: 'small' }));
		expect(vms.find((v) => v.vmid === 101)?.node).toBe('pve2');

		expect(await adapter.listRegions(creds())).toEqual([
			{ id: 'pve1', name: 'pve1' },
			{ id: 'pve2', name: 'pve2' }
		]);
		const small = await adapter.listOffers(creds(), 'pve2');
		expect(small.map((o) => o.id)).toEqual(['small', 'medium']);
		// $73 a month is $0.10 an hour for the host; 4 GB of its 8 GB is half that
		expect(small[0]).toMatchObject({ hourly: 0.05, arch: 'amd64', gpu: null, diskGb: null });
		expect((await adapter.listOffers(creds(), 'pve1')).map((o) => o.id)).toEqual([
			'small',
			'medium',
			'large',
			'xlarge'
		]);
		expect(await adapter.listOffers(creds(), 'pve3')).toEqual([]);
	});

	it('never destroys a VM it did not create', async () => {
		await expect(adapter.destroyNode(creds(), '100')).rejects.toThrow("wasn't created by Tramline");
		await expect(adapter.destroyNode(creds(), '9000')).rejects.toThrow(
			"wasn't created by Tramline"
		);
		expect(await adapter.getNode(creds(), '100')).toBeNull();
		// already gone is fine
		await adapter.destroyNode(creds(), '555');
	});

	it('stops a VM before destroying it, even while the cluster still lists it as stopped', async () => {
		await adapter.createNode(creds(), spec());
		const vm = vms.find((v) => v.vmid === 101)!;
		vm.listed = 'stopped';
		await adapter.destroyNode(creds(), '101');
		expect(requests.join('\n')).toMatch(
			/POST \S+\/qemu\/101\/status\/stop\n[^]*DELETE \S+\/qemu\/101/
		);
		expect(vms.some((v) => v.vmid === 101)).toBe(false);
	});

	it('removes a clone it could not set up', async () => {
		failNext = '/qemu/101/config';
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(
			'The API token lacks a permission: Permission check failed (/vms/101, VM.Config.Options)'
		);
		expect(vms.some((v) => v.vmid === 101)).toBe(false);
	});

	it('checks the template and the size', async () => {
		await expect(adapter.validate(creds({ template: 100 }))).rejects.toThrow(
			'VM 100 is not a template'
		);
		await expect(adapter.validate(creds({ template: 4242 }))).rejects.toThrow(
			'There is no VM 4242'
		);
		await expect(adapter.createNode(creds(), spec({ offer: 'huge' }))).rejects.toThrow(
			'There is no huge size'
		);
	});

	it('rejects container templates before attempting a QEMU clone', async () => {
		vms.find((vm) => vm.vmid === 9000)!.type = 'lxc' as never;
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow('not a QEMU template');
		expect(requests.some((request) => request.endsWith('/clone'))).toBe(false);
	});

	it('pins the certificate: a wrong fingerprint fails before the token is sent', async () => {
		const wrong = fingerprint.replace(/^../, fingerprint.startsWith('00') ? '11' : '00');
		const before = requests.length;
		await expect(adapter.validate(creds({ fingerprint: wrong }))).rejects.toThrow(
			"certificate doesn't match the fingerprint"
		);
		expect(requests.length).toBe(before);
		// A pin alone never bypasses normal certificate validation.
		await expect(adapter.validate(creds({ caCertificate: undefined }))).rejects.toThrow(
			"Couldn't reach 127.0.0.1"
		);
	});

	it('rejects a trusted, pinned certificate with the wrong hostname before sending the token', async () => {
		server.setSecureContext(wrongHostContext);
		try {
			await expect(
				adapter.validate(
					creds({
						caCertificate: wrongHostCertificate,
						fingerprint: new X509Certificate(wrongHostCertificate).fingerprint256
					})
				)
			).rejects.toThrow('not in the cert');
			expect(requests).toHaveLength(0);
		} finally {
			server.setSecureContext(validContext);
		}
	});

	it('rejects paths that could leak API credentials', async () => {
		const before = requests.length;
		await expect(
			adapter.validate(creds({ fingerprint: undefined, caCertificate: undefined }))
		).rejects.toThrow();
		const api = new ProxmoxClient(creds());
		for (const path of [
			'https://example.com/api2/json/version',
			'//example.com/version',
			'../version'
		]) {
			await expect(api.get(path)).rejects.toThrow('must stay within');
		}
		expect(requests).toHaveLength(before);
	});

	it('explains rejected tokens, other errors, and unreachable hosts', async () => {
		await expect(adapter.validate(creds({ tokenSecret: 'nope' }))).rejects.toThrow(
			'Proxmox rejected the API token'
		);
		await expect(adapter.getNode(creds(), '1')).resolves.toBeNull();
		await expect(adapter.validate(creds({ url: 'https://127.0.0.1:1' }))).rejects.toThrow(
			"Couldn't reach 127.0.0.1:1"
		);
		expect(() => adapter.validate(creds({ url: 'http://pve.test' }))).rejects.toThrow('https://');
		vms = vms.filter((v) => v.vmid !== 9000);
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow('There is no VM 9000');
	});

	it('generates its "Connect account" form', async () => {
		const { credentialFields } = await import('@tramline/adapter-sdk');
		const fields = credentialFields(adapter.credentials);
		expect(fields.map((f) => [f.key, f.required, f.secret])).toEqual([
			['url', true, false],
			['tokenId', true, false],
			['tokenSecret', true, true],
			['fingerprint', false, false],
			['caCertificate', false, false],
			['template', true, false],
			['storage', false, false],
			['pool', false, false],
			['monthlyCost', false, false]
		]);
	});
});

describe('VMs and tasks', () => {
	it('reports each tagged VM with its state, and ignores containers and untagged VMs', async () => {
		const base = { node: 'pve1', template: 0, config: {}, type: 'qemu' as const };
		vms.push(
			{ ...base, vmid: 201, name: 'booting', status: 'stopped', tags: 'tramline' },
			{ ...base, vmid: 202, name: 'off', status: 'stopped', tags: 'x;tramline' },
			{ ...base, vmid: 203, name: 'paused', status: 'paused' as never, tags: 'tramline' },
			{ ...base, vmid: 204, name: 'ct', status: 'running', tags: 'tramline', type: 'lxc' as never }
		);
		Object.assign(
			vms.find((v) => v.vmid === 201)!,
			{ lock: 'clone' }
		);
		delete (vms.find((v) => v.vmid === 202) as Partial<Vm>).name;
		expect((await adapter.listNodes(creds())).map((n) => [n.id, n.name, n.status])).toEqual([
			['201', 'booting', 'provisioning'],
			['202', 'vm-202', 'stopped'],
			['203', 'paused', 'unknown']
		]);
		expect(await adapter.getNode(creds(), '204')).toBeNull();
	});

	it('fails when a Proxmox task fails or never finishes', async () => {
		taskStatus = { status: 'stopped', exitstatus: 'clone failed: out of space' };
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(
			'A Proxmox task failed: clone failed: out of space'
		);
		expect(vms.some((v) => v.vmid === 101)).toBe(false);
		taskStatus = { status: 'running' };
		const impatient = proxmoxAdapter({ pollMs: 1, taskTimeoutMs: 5 });
		await expect(impatient.createNode(creds(), spec())).rejects.toThrow('took too long');
	});

	it("passes on Proxmox's own error details", async () => {
		const api = new ProxmoxClient(creds());
		await expect(api.get('nodes/pve1/qemu/999/config')).rejects.toThrow(
			'Proxmox answered 500 no such VM: no such VM'
		);
		await expect(api.get('nodes/pve1/nothing')).rejects.toThrow('Proxmox answered 501');
	});
});

describe.skipIf(!process.env.TRAMLINE_PROXMOX_URL)('against a real Proxmox', () => {
	it(
		'passes the conformance suite',
		async () => {
			const steps = await conformance(proxmoxAdapter(), {
				credentials: {
					url: process.env.TRAMLINE_PROXMOX_URL!,
					tokenId: process.env.TRAMLINE_PROXMOX_TOKEN_ID!,
					tokenSecret: process.env.TRAMLINE_PROXMOX_TOKEN_SECRET!,
					fingerprint: process.env.TRAMLINE_PROXMOX_FINGERPRINT || undefined,
					caCertificate: process.env.TRAMLINE_PROXMOX_CA_CERTIFICATE || undefined,
					template: Number(process.env.TRAMLINE_PROXMOX_TEMPLATE),
					storage: process.env.TRAMLINE_PROXMOX_STORAGE || undefined,
					monthlyCost: 0
				},
				region: process.env.TRAMLINE_PROXMOX_NODE,
				offer: 'small'
			});
			expect(steps).toContain('no orphans');
		},
		15 * 60_000
	);
});
