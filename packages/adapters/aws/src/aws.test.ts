import { conformance, type NodeSpec } from '@tramline/adapter-sdk';
import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	awsAdapter,
	CANONICAL,
	instanceName,
	METADATA_ADDRESS,
	type AwsCredentials
} from './index';
import { parseXml, text } from './xml';

/**
 * A fake EC2 that checks every request's SigV4 signature (computed here on
 * its own, not with the client's code) and keeps instances, security groups
 * and their rules. Instances go pending → running, and shutting-down →
 * terminated, one describe at a time; terminated ones stay listed, as in EC2.
 */

const KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const NOW = new Date('2026-11-03T12:00:00Z');

const creds = (overrides: Partial<AwsCredentials> = {}): AwsCredentials => ({
	accessKeyId: KEY,
	secretAccessKey: SECRET,
	diskGb: 20,
	openMeshPort: true,
	...overrides
});

interface Instance {
	id: string;
	region: string;
	state: string;
	tags: Record<string, string>;
	params: Record<string, string>;
	groups: string[];
}

let instances: Instance[];
let groups: { id: string; region: string; name: string; vpc: string; rules: string[] }[];
let actions: string[];
let full: Set<string>;
let denied: Set<string>;
let noDefaultVpc: boolean;
let seq: number;

function reset() {
	instances = [
		{
			id: 'i-0000000000000aaaa',
			region: 'us-east-1',
			state: 'running',
			tags: { Name: 'theirs' },
			params: {},
			groups: ['sg-theirs']
		}
	];
	groups = [];
	actions = [];
	full = new Set();
	denied = new Set();
	noDefaultVpc = false;
	seq = 0;
}

const xml = (action: string, body: string) =>
	new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<${action}Response xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>r-1</requestId>${body}</${action}Response>`,
		{ headers: { 'content-type': 'text/xml;charset=UTF-8' } }
	);
const awsError = (status: number, code: string, message: string) =>
	new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<Response><Errors><Error><Code>${code}</Code><Message>${message}</Message></Error></Errors><RequestID>r-2</RequestID></Response>`,
		{ status }
	);
const items = (list: string[]) => list.map((item) => `<item>${item}</item>`).join('');

/** SigV4 on its own, from the AWS documentation's steps. */
function expectedSignature(headers: Headers, body: string, host: string, region: string) {
	const sha = (v: string) => createHash('sha256').update(v).digest('hex');
	const mac = (k: string | Buffer, v: string) => createHmac('sha256', k).update(v).digest();
	const date = headers.get('x-amz-date')!;
	const canonical = `POST\n/\n\ncontent-type:${headers.get('content-type')}\nhost:${host}\nx-amz-date:${date}\n\ncontent-type;host;x-amz-date\n${sha(body)}`;
	const scope = `${date.slice(0, 8)}/${region}/ec2/aws4_request`;
	const key = mac(mac(mac(mac(`AWS4${SECRET}`, date.slice(0, 8)), region), 'ec2'), 'aws4_request');
	return createHmac('sha256', key)
		.update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`)
		.digest('hex');
}

/** EC2's Filter.N.Name / Filter.N.Value.M, back into a map. */
function filtersOf(params: Record<string, string>) {
	const found: Record<string, string[]> = {};
	for (const [key, name] of Object.entries(params)) {
		const m = key.match(/^Filter\.(\d+)\.Name$/);
		if (!m) continue;
		found[name] = Object.entries(params)
			.filter(([k]) => k.startsWith(`Filter.${m[1]}.Value.`))
			.map(([, v]) => v);
	}
	return found;
}

const matches = (instance: Instance, filters: Record<string, string[]>) =>
	Object.entries(filters).every(([name, values]) => {
		if (name === 'instance-state-name') return values.includes(instance.state);
		if (name.startsWith('tag:')) return values.includes(instance.tags[name.slice(4)] ?? '');
		return true;
	});

const instanceXml = (i: Instance) =>
	`<instanceId>${i.id}</instanceId><instanceState><code>16</code><name>${i.state}</name></instanceState>` +
	(i.state === 'running' ? '<ipAddress>54.0.0.10</ipAddress>' : '') +
	`<vpcId>vpc-1</vpcId><groupSet>${items(i.groups.map((g) => `<groupId>${g}</groupId><groupName>${groups.find((x) => x.id === g)?.name ?? 'other'}</groupName>`))}</groupSet>` +
	`<tagSet>${items(Object.entries(i.tags).map(([k, v]) => `<key>${k}</key><value>${v}</value>`))}</tagSet>`;

async function handle(url: URL, init: RequestInit): Promise<Response> {
	const region = url.hostname.match(/^ec2\.([a-z0-9-]+)\.amazonaws\.com$/)![1]!;
	const body = String(init.body);
	const headers = new Headers(init.headers);
	const auth = headers.get('authorization')!;
	const credential = auth.match(/Credential=([^/]+)\/(\d{8})\/([^/]+)\/ec2\/aws4_request/)!;
	expect(credential[2]).toBe('20261103');
	expect(credential[3]).toBe(region);
	if (credential[1] !== KEY) {
		return awsError(
			401,
			'AuthFailure',
			'AWS was not able to validate the provided access credentials'
		);
	}
	if (auth.split('Signature=')[1] !== expectedSignature(headers, body, url.host, region)) {
		return awsError(
			403,
			'SignatureDoesNotMatch',
			'The request signature we calculated does not match'
		);
	}
	const params = Object.fromEntries(new URLSearchParams(body));
	expect(params.Version).toBe('2016-11-15');
	const action = params.Action!;
	actions.push(`${region} ${action}`);
	if (denied.has(action)) {
		return awsError(
			403,
			'UnauthorizedOperation',
			`You are not authorized to perform this operation. User: arn:aws:iam::123:user/tramline is not authorized to perform: ec2:${action}. Encoded authorization failure message: abc`
		);
	}
	const filters = filtersOf(params);

	switch (action) {
		case 'DescribeRegions':
			return xml(
				action,
				`<regionInfo>${items(['us-east-1', 'eu-west-2', 'xx-new-1'].map((r) => `<regionName>${r}</regionName><optInStatus>opt-in-not-required</optInStatus>`))}</regionInfo>`
			);
		case 'DescribeInstances': {
			let found: Instance[];
			if (params['InstanceId.1']) {
				const instance = instances.find(
					(i) => i.id === params['InstanceId.1'] && i.region === region
				);
				if (!instance) {
					return awsError(
						400,
						'InvalidInstanceID.NotFound',
						`The instance ID '${params['InstanceId.1']}' does not exist`
					);
				}
				found = [instance];
			} else {
				found = instances.filter((i) => i.region === region && matches(i, filters));
			}
			const reply = xml(
				action,
				`<reservationSet>${items(found.map((i) => `<reservationId>r-${i.id}</reservationId><instancesSet>${items([instanceXml(i)])}</instancesSet>`))}</reservationSet>`
			);
			for (const i of found) {
				if (i.state === 'pending') i.state = 'running';
				else if (i.state === 'shutting-down') i.state = 'terminated';
			}
			return reply;
		}
		case 'DescribeImages':
			expect(params['Owner.1']).toBe(CANONICAL);
			expect(filters.name![0]).toContain('ubuntu-noble-24.04-amd64');
			return xml(
				action,
				`<imagesSet>${items([
					'<imageId>ami-old</imageId><creationDate>2026-06-01T00:00:00.000Z</creationDate><rootDeviceName>/dev/sda1</rootDeviceName>',
					'<imageId>ami-new</imageId><creationDate>2026-10-20T00:00:00.000Z</creationDate><rootDeviceName>/dev/sda1</rootDeviceName>'
				])}</imagesSet>`
			);
		case 'DescribeVpcs':
			return xml(
				action,
				`<vpcSet>${noDefaultVpc ? '' : items(['<vpcId>vpc-1</vpcId><isDefault>true</isDefault>'])}</vpcSet>`
			);
		case 'DescribeSubnets':
			return xml(
				action,
				`<subnetSet>${items([
					'<subnetId>subnet-b</subnetId><availabilityZone>us-east-1b</availabilityZone>',
					'<subnetId>subnet-a</subnetId><availabilityZone>us-east-1a</availabilityZone>'
				])}</subnetSet>`
			);
		case 'DescribeSecurityGroups': {
			const found = groups.filter(
				(g) =>
					g.region === region &&
					g.name === filters['group-name']![0] &&
					g.vpc === filters['vpc-id']![0]
			);
			return xml(
				action,
				`<securityGroupInfo>${items(found.map((g) => `<groupId>${g.id}</groupId>`))}</securityGroupInfo>`
			);
		}
		case 'CreateSecurityGroup': {
			const id = `sg-${++seq}`;
			groups.push({ id, region, name: params.GroupName!, vpc: params.VpcId!, rules: [] });
			return xml(action, `<return>true</return><groupId>${id}</groupId>`);
		}
		case 'AuthorizeSecurityGroupIngress': {
			const group = groups.find((g) => g.id === params.GroupId)!;
			const rule = `${params['IpPermissions.1.IpProtocol']}/${params['IpPermissions.1.FromPort']} ${params['IpPermissions.1.IpRanges.1.CidrIp']} ${params['IpPermissions.1.Ipv6Ranges.1.CidrIpv6']}`;
			if (group.rules.includes(rule)) {
				return awsError(400, 'InvalidPermission.Duplicate', 'the specified rule already exists');
			}
			group.rules.push(rule);
			return xml(action, '<return>true</return>');
		}
		case 'DescribeInstanceTypes': {
			const all = [
				['t3.micro', 2, 1024],
				['m7i.large', 2, 8192],
				['t3.nano', 2, 512],
				['m7i.8xlarge', 32, 131_072],
				['c7i.xlarge', 4, 8192],
				['m7i.metal-24xl', 96, 393_216]
			] as const;
			const page = params.NextToken === 'page-2' ? all.slice(3) : all.slice(0, 3);
			return xml(
				action,
				`<instanceTypeSet>${items(page.map(([name, vcpus, mem]) => `<instanceType>${name}</instanceType><vCpuInfo><defaultVCpus>${vcpus}</defaultVCpus></vCpuInfo><memoryInfo><sizeInMiB>${mem}</sizeInMiB></memoryInfo>`))}</instanceTypeSet>` +
					(params.NextToken ? '' : '<nextToken>page-2</nextToken>')
			);
		}
		case 'RunInstances': {
			const subnet = params['NetworkInterface.1.SubnetId']!;
			if (full.has(subnet)) {
				return awsError(
					500,
					'InsufficientInstanceCapacity',
					`We currently do not have sufficient ${params.InstanceType} capacity in the Availability Zone you requested`
				);
			}
			const tags: Record<string, string> = {};
			for (let n = 1; params[`TagSpecification.1.Tag.${n}.Key`]; n++) {
				tags[params[`TagSpecification.1.Tag.${n}.Key`]!] =
					params[`TagSpecification.1.Tag.${n}.Value`]!;
			}
			const instance: Instance = {
				id: `i-${String(++seq).padStart(17, '0')}`,
				region,
				state: 'pending',
				tags,
				params,
				groups: [params['NetworkInterface.1.SecurityGroupId.1'] ?? 'sg-default']
			};
			instances.push(instance);
			return xml(action, `<instancesSet>${items([instanceXml(instance)])}</instancesSet>`);
		}
		case 'ModifyInstanceAttribute': {
			const instance = instances.find((i) => i.id === params.InstanceId)!;
			instance.groups = Object.entries(params)
				.filter(([k]) => /^GroupId\.\d+$/.test(k))
				.sort(([a], [b]) => Number(a.slice(8)) - Number(b.slice(8)))
				.map(([, v]) => v);
			return xml(action, '<return>true</return>');
		}
		case 'TerminateInstances': {
			const instance = instances.find((i) => i.id === params['InstanceId.1'])!;
			instance.state = 'shutting-down';
			return xml(action, '<instancesSet></instancesSet>');
		}
	}
	return awsError(400, 'InvalidAction', `unexpected ${action}`);
}

const fetcher = (async (input: string | URL, init: RequestInit = {}) =>
	handle(new URL(String(input)), init)) as typeof fetch;

const adapter = awsAdapter({ fetch: fetcher, now: () => NOW });

const spec = (overrides: Partial<NodeSpec> = {}): NodeSpec => ({
	name: 'aws-node',
	region: 'us-east-1',
	offer: 't3.micro',
	install: {
		url: 'https://tramline.example.com',
		token: 'tljoin_abc',
		command: 'curl … | sudo sh'
	},
	userData: '#cloud-config',
	seedUrl: 'https://tramline.example.com/api/agent/v1/seed/x/',
	...overrides
});

beforeEach(reset);

describe('AWS adapter', () => {
	it('passes the conformance suite', async () => {
		const steps = await conformance(adapter, {
			credentials: creds(),
			invalidCredentials: creds({ secretAccessKey: 'x'.repeat(40) }),
			region: 'us-east-1',
			offer: 't3.micro',
			pollMs: 1
		});
		expect(steps).toContain('no orphans');
		expect(instances.filter((i) => i.state !== 'terminated').map((i) => i.tags.Name)).toEqual([
			'theirs'
		]);
	});

	it('checks the key’s shape before calling AWS', () => {
		const schema = adapter.credentials;
		expect(schema.safeParse(creds({ accessKeyId: 'my-key' })).success).toBe(false);
		expect(schema.safeParse(creds({ secretAccessKey: 'short' })).success).toBe(false);
		expect(schema.parse({ accessKeyId: ` ${KEY} `, secretAccessKey: SECRET })).toEqual({
			accessKeyId: KEY,
			secretAccessKey: SECRET,
			diskGb: 20,
			openMeshPort: true
		});
	});

	it('explains an unknown key, a wrong secret and a missing permission', async () => {
		await expect(adapter.validate(creds({ accessKeyId: 'AKIAEXAMPLE000000000' }))).rejects.toThrow(
			/doesn’t recognise that access key/
		);
		await expect(adapter.validate(creds({ secretAccessKey: 'y'.repeat(40) }))).rejects.toThrow(
			/refused the secret access key/
		);
		denied.add('DescribeInstances');
		await expect(adapter.validate(creds())).rejects.toThrow(
			/not authorized to perform: ec2:DescribeInstances\. Attach the policy in docs\/adapters\/aws\.md/
		);
	});

	it('lists enabled regions with where they are', async () => {
		expect(await adapter.listRegions(creds())).toEqual([
			{ id: 'eu-west-2', name: 'eu-west-2 (London)' },
			{ id: 'us-east-1', name: 'us-east-1 (N. Virginia)' },
			{ id: 'xx-new-1', name: 'xx-new-1' }
		]);
	});

	it('offers current x86 sizes up to 16 vCPUs over every page, smallest first', async () => {
		const offers = await adapter.listOffers(creds(), 'us-east-1');
		expect(offers.map((o) => o.id)).toEqual(['t3.nano', 't3.micro', 'm7i.large', 'c7i.xlarge']);
		expect(offers[1]).toMatchObject({ vcpus: 2, memoryMb: 1024, diskGb: 20, arch: 'amd64' });
		await expect(adapter.listOffers(creds(), 'moon-1')).rejects.toThrow(/no region called moon-1/);
	});

	it('runs a tagged instance with no role, IMDSv2 one hop only, an encrypted disk and the mesh port', async () => {
		const node = await adapter.createNode(creds(), spec());
		expect(node).toMatchObject({ name: 'aws-node', region: 'us-east-1', status: 'provisioning' });
		expect(node.id).toMatch(/^us-east-1\/i-0+\d+$/);

		const { params, tags } = instances.at(-1)!;
		expect(tags).toEqual({ tramline: 'node', Name: 'aws-node' });
		expect(params).toMatchObject({
			ImageId: 'ami-new',
			InstanceType: 't3.micro',
			'NetworkInterface.1.SubnetId': 'subnet-a',
			'NetworkInterface.1.AssociatePublicIpAddress': 'true',
			'NetworkInterface.1.SecurityGroupId.1': 'sg-1',
			'BlockDeviceMapping.1.DeviceName': '/dev/sda1',
			'BlockDeviceMapping.1.Ebs.VolumeSize': '20',
			'BlockDeviceMapping.1.Ebs.Encrypted': 'true',
			'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
			'MetadataOptions.HttpTokens': 'required',
			'MetadataOptions.HttpPutResponseHopLimit': '1',
			'TagSpecification.2.ResourceType': 'volume'
		});
		expect(Object.keys(params).some((k) => k.startsWith('IamInstanceProfile'))).toBe(false);
		expect(Object.keys(params).some((k) => k.startsWith('KeyName'))).toBe(false);
		const userData = Buffer.from(params.UserData!, 'base64').toString();
		expect(userData).toContain("--token 'tljoin_abc'");
		expect(userData).toContain(`ADDRESS=$(${METADATA_ADDRESS} || true)`);

		expect(groups).toEqual([
			expect.objectContaining({
				name: 'tramline-mesh',
				vpc: 'vpc-1',
				rules: ['udp/51820 0.0.0.0/0 ::/0']
			})
		]);
		// a second node reuses the group and its rule
		await adapter.createNode(creds(), spec({ name: 'second' }));
		expect(groups).toHaveLength(1);

		expect(await adapter.getNode(creds(), node.id)).toMatchObject({
			status: 'provisioning',
			address: null
		});
		expect(await adapter.getNode(creds(), node.id)).toMatchObject({
			status: 'running',
			address: '54.0.0.10'
		});
	});

	it('tries the next zone when one is full, and says when all are', async () => {
		full.add('subnet-a');
		await adapter.createNode(creds(), spec());
		expect(instances.at(-1)!.params['NetworkInterface.1.SubnetId']).toBe('subnet-b');
		full.add('subnet-b');
		await expect(adapter.createNode(creds(), spec({ name: 'next' }))).rejects.toThrow(
			/No availability zone in us-east-1 can run a t3\.micro.*Try another size or region/
		);
	});

	it('won’t reuse a name, needs a default VPC, and can leave the mesh port alone', async () => {
		await adapter.createNode(creds(), spec());
		await expect(adapter.createNode(creds(), spec())).rejects.toThrow(
			/already has a Tramline instance called aws-node/
		);
		await adapter.createNode(creds({ openMeshPort: false }), spec({ name: 'closed' }));
		expect(instances.at(-1)!.params['NetworkInterface.1.SecurityGroupId.1']).toBeUndefined();
		expect(groups).toHaveLength(1);
		noDefaultVpc = true;
		await expect(adapter.createNode(creds(), spec({ name: 'novpc' }))).rejects.toThrow(
			/Create default VPC/
		);
	});

	it('only lists and terminates instances it created', async () => {
		const node = await adapter.createNode(creds(), spec());
		expect((await adapter.listNodes(creds())).map((n) => n.id)).toEqual([node.id]);
		expect(await adapter.getNode(creds(), 'us-east-1/i-0000000000000aaaa')).toBeNull();
		await expect(adapter.destroyNode(creds(), 'us-east-1/i-0000000000000aaaa')).rejects.toThrow(
			/left alone/
		);
		expect(instances[0]!.state).toBe('running');
		await expect(adapter.getNode(creds(), 'not-an-id')).rejects.toThrow(/isn't an EC2 instance ID/);
		expect(await adapter.getNode(creds(), 'us-east-1/i-0123456789abcdef0')).toBeNull();
	});

	it('opens TCP 80 and 443 to an edge instance through its own security group, and closes them', async () => {
		const node = await adapter.createNode(creds(), spec());
		const instance = instances.at(-1)!;
		await adapter.setEdge!(creds(), node.id, true);
		expect(groups.find((g) => g.name === 'tramline-edge')).toMatchObject({
			vpc: 'vpc-1',
			rules: ['tcp/80 0.0.0.0/0 ::/0', 'tcp/443 0.0.0.0/0 ::/0']
		});
		const edge = groups.find((g) => g.name === 'tramline-edge')!.id;
		// the mesh group stays, and the mesh group's rules are untouched
		expect(instance.groups).toEqual(['sg-1', edge]);
		expect(groups.find((g) => g.name === 'tramline-mesh')!.rules).toEqual([
			'udp/51820 0.0.0.0/0 ::/0'
		]);

		// opening again changes nothing; a second node reuses the group
		await adapter.setEdge!(creds(), node.id, true);
		expect(actions.filter((a) => a.endsWith('ModifyInstanceAttribute'))).toHaveLength(1);
		const second = await adapter.createNode(creds(), spec({ name: 'second' }));
		await adapter.setEdge!(creds(), second.id, true);
		expect(groups.filter((g) => g.name === 'tramline-edge')).toHaveLength(1);

		await adapter.setEdge!(creds(), node.id, false);
		expect(instance.groups).toEqual(['sg-1']);
		await adapter.setEdge!(creds(), node.id, false);
		expect(actions.filter((a) => a.endsWith('ModifyInstanceAttribute'))).toHaveLength(3);

		// a machine that's gone has nothing to close, and can't be opened
		await adapter.setEdge!(creds(), 'us-east-1/i-0123456789abcdef0', false);
		await expect(adapter.setEdge!(creds(), 'us-east-1/i-0123456789abcdef0', true)).rejects.toThrow(
			/There is no instance/
		);
	});

	it('only changes the groups of instances it created, and closes nothing that was never opened', async () => {
		await expect(adapter.setEdge!(creds(), 'us-east-1/i-0000000000000aaaa', true)).rejects.toThrow(
			/left alone/
		);
		expect(instances[0]!.groups).toEqual(['sg-theirs']);
		const node = await adapter.createNode(creds(), spec());
		await adapter.setEdge!(creds(), node.id, false);
		expect(groups.some((g) => g.name === 'tramline-edge')).toBe(false);
		denied.add('ModifyInstanceAttribute');
		await expect(adapter.setEdge!(creds(), node.id, true)).rejects.toThrow(
			/ec2:ModifyInstanceAttribute/
		);
	});

	it('keeps Name tags printable and short', () => {
		expect(instanceName('aws-node')).toBe('aws-node');
		expect(instanceName('a<b>c')).toBe('a-b-c');
		expect(instanceName('x'.repeat(80))).toHaveLength(63);
		expect(instanceName('')).toBe('tramline-node');
	});
});

describe('XML', () => {
	it('reads elements, text, entities, CDATA and comments', () => {
		const doc = parseXml(
			'<?xml version="1.0"?><!-- c --><a xmlns="x"><b>1 &lt; 2 &amp;&#65;&#x42;</b><c><![CDATA[<raw>]]></c><d/></a>'
		);
		const a = doc.children[0];
		expect(text(a, 'b')).toBe('1 < 2 &AB');
		expect(text(a, 'c')).toBe('<raw>');
		expect(text(a, 'd')).toBe('');
		expect(text(a, 'missing')).toBeNull();
	});

	it('rejects malformed XML, and never expands a DTD', () => {
		expect(() => parseXml('<a><b></a>')).toThrow(/Unexpected <\/a>/);
		expect(() => parseXml('<a>')).toThrow(/Unclosed <a>/);
		expect(() => parseXml('<a><!-- open')).toThrow(/Unterminated/);
		const doc = parseXml('<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>');
		expect(doc.children.find((c) => c.name === 'a')!.text).toBe('&x;');
	});

	it('runs in linear time on hostile input', () => {
		const started = performance.now();
		expect(() => parseXml('<a>' + '<'.repeat(100_000))).toThrow();
		parseXml(`<a>${'&amp;'.repeat(100_000)}</a>`);
		expect(performance.now() - started).toBeLessThan(500);
	});
});

// a real account: TRAMLINE_AWS_KEY_ID, TRAMLINE_AWS_SECRET and TRAMLINE_AWS_REGION
describe.skipIf(!process.env.TRAMLINE_AWS_SECRET)('AWS adapter against AWS', () => {
	it('passes the conformance suite', { timeout: 15 * 60_000 }, async () => {
		const steps = await conformance(awsAdapter(), {
			credentials: creds({
				accessKeyId: process.env.TRAMLINE_AWS_KEY_ID!,
				secretAccessKey: process.env.TRAMLINE_AWS_SECRET!
			}),
			region: process.env.TRAMLINE_AWS_REGION ?? 'us-east-1',
			offer: 't3.micro',
			pollMs: 5_000
		});
		expect(steps).toContain('no orphans');
	});
});
