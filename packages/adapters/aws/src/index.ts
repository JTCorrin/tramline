import {
	AdapterError,
	cloudInit,
	defineAdapter,
	type Offer,
	type ProviderNode,
	type Region
} from '@tramline/adapter-sdk';
import { z } from 'zod';
import { AwsClient, AwsError, type ClientOptions } from './client';
import { items, text, type XmlNode } from './xml';

/**
 * AWS EC2: one instance per node, from Canonical's latest Ubuntu 24.04 AMI,
 * in the region's default VPC with a public address. Instances have no IAM
 * role, so a compromised node has no AWS access, and their metadata service
 * needs IMDSv2 tokens with a hop limit of 1: a container on Docker's bridge
 * network, one hop further, can't reach it at all (and so can't read the
 * user data with the join token, or anything else about the machine).
 *
 * Instances and their volumes carry the `tramline` tag; the adapter only
 * ever terminates tagged instances. A security group opens the mesh port
 * (UDP 51820). See docs/adapters/aws.md for the IAM policy.
 */

export const TAG = 'tramline';
export const MESH_PORT = 51820;
export const SECURITY_GROUP = 'tramline-mesh';
/** Canonical's account, which publishes the official Ubuntu AMIs. */
export const CANONICAL = '099720109477';
const UBUNTU = 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*';
/** The region every account can call to list the others. */
const HOME_REGION = 'us-east-1';
/** The address the metadata service (IMDSv2) gives the instance. */
export const METADATA_ADDRESS =
	'curl -fsS -H "X-aws-ec2-metadata-token: $(curl -fsS -X PUT -H \'X-aws-ec2-metadata-token-ttl-seconds: 60\' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/public-ipv4';

const credentials = z.object({
	accessKeyId: z
		.string()
		.trim()
		.regex(/^(AKIA|ASIA)[A-Z0-9]{12,124}$/, 'An access key ID starts with AKIA')
		.meta({
			title: 'Access key ID',
			description: 'From IAM → Users → (the user) → Security credentials → Create access key'
		}),
	secretAccessKey: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9/+=]{30,128}$/, 'Paste the whole secret access key')
		.meta({
			title: 'Secret access key',
			description: 'Shown once, when the key is created. Tramline keeps it encrypted.',
			secret: true
		}),
	diskGb: z.coerce.number().int().min(8).max(16_384).default(20).meta({ title: 'Disk size (GB)' }),
	openMeshPort: z
		.boolean()
		.default(true)
		.meta({
			title: 'Open the mesh port',
			description: `Adds a security group, ${SECURITY_GROUP}, letting other nodes reach these instances on UDP ${MESH_PORT}.`
		})
});

export type AwsCredentials = z.infer<typeof credentials>;

/**
 * Current general-purpose x86 families worth offering, up to 16 vCPUs.
 * t3.micro is free-tier eligible. GPU instances come with 7d.
 */
const FAMILIES = ['t3', 't3a', 'm6i', 'm7i', 'm7i-flex', 'm7a', 'c7i', 'r7i'];
const SIZE = /^(t3a?|m6i|m7i|m7i-flex|m7a|c7i|r7i)\.(nano|micro|small|medium|large|\d*xlarge)$/;
const MAX_VCPUS = 16;

/** Where each region is, since the API only has its name. */
const PLACES: Record<string, string> = {
	'af-south-1': 'Cape Town',
	'ap-east-1': 'Hong Kong',
	'ap-northeast-1': 'Tokyo',
	'ap-northeast-2': 'Seoul',
	'ap-northeast-3': 'Osaka',
	'ap-south-1': 'Mumbai',
	'ap-south-2': 'Hyderabad',
	'ap-southeast-1': 'Singapore',
	'ap-southeast-2': 'Sydney',
	'ap-southeast-3': 'Jakarta',
	'ap-southeast-4': 'Melbourne',
	'ca-central-1': 'Canada',
	'ca-west-1': 'Calgary',
	'eu-central-1': 'Frankfurt',
	'eu-central-2': 'Zurich',
	'eu-north-1': 'Stockholm',
	'eu-south-1': 'Milan',
	'eu-south-2': 'Spain',
	'eu-west-1': 'Ireland',
	'eu-west-2': 'London',
	'eu-west-3': 'Paris',
	'il-central-1': 'Tel Aviv',
	'me-central-1': 'UAE',
	'me-south-1': 'Bahrain',
	'sa-east-1': 'São Paulo',
	'us-east-1': 'N. Virginia',
	'us-east-2': 'Ohio',
	'us-west-1': 'N. California',
	'us-west-2': 'Oregon'
};

/** EC2's numbered list parameters: `Filter.1.Name`, `Filter.1.Value.1`, … */
function filters(values: Record<string, string[]>) {
	const params: Record<string, string> = {};
	Object.entries(values).forEach(([name, list], i) => {
		params[`Filter.${i + 1}.Name`] = name;
		list.forEach((value, j) => (params[`Filter.${i + 1}.Value.${j + 1}`] = value));
	});
	return params;
}

function tags(prefix: string, values: Record<string, string>) {
	const params: Record<string, string> = {};
	Object.entries(values).forEach(([key, value], i) => {
		params[`${prefix}.Tag.${i + 1}.Key`] = key;
		params[`${prefix}.Tag.${i + 1}.Value`] = value;
	});
	return params;
}

function tagOf(instance: XmlNode, key: string) {
	const tag = items(instance, 'tagSet').find((t) => text(t, 'key') === key);
	return tag ? text(tag, 'value') : null;
}

/** A name for the Name tag: printable, at most 63 characters. */
export function instanceName(node: string) {
	return node.replace(/[^\w .:/=+@-]/g, '-').slice(0, 63) || 'tramline-node';
}

function toNode(instance: XmlNode, region: string): ProviderNode {
	const state = text(instance, 'instanceState', 'name');
	const id = text(instance, 'instanceId')!;
	return {
		id: `${region}/${id}`,
		name: tagOf(instance, 'Name') ?? id,
		region,
		status:
			state === 'running'
				? 'running'
				: state === 'pending'
					? 'provisioning'
					: state && ['stopping', 'stopped', 'shutting-down'].includes(state)
						? 'stopped'
						: 'unknown',
		address: text(instance, 'ipAddress'),
		instructions: null
	};
}

/** `region/instance-id`, as `createNode` returns it. */
function splitId(id: string) {
	const match = id.match(/^([a-z]{2}(?:-[a-z]+)+-\d)\/(i-[0-9a-f]{8,17})$/);
	if (!match) throw new AdapterError(`${id} isn't an EC2 instance ID (region/i-…)`);
	return { region: match[1]!, instanceId: match[2]! };
}

/** Shortages and gaps worth trying the next availability zone for. */
const NEXT_ZONE = new Set(['InsufficientInstanceCapacity', 'Unsupported']);

export function awsAdapter(options: ClientOptions = {}) {
	const client = (creds: AwsCredentials) => new AwsClient(creds, options);

	async function regions(api: AwsClient) {
		const found = await api.call(HOME_REGION, 'DescribeRegions');
		return items(found, 'regionInfo').map((r) => text(r, 'regionName')!);
	}

	async function describe(api: AwsClient, id: string) {
		const { region, instanceId } = splitId(id);
		try {
			const found = await api.call(region, 'DescribeInstances', { 'InstanceId.1': instanceId });
			const instance = items(items(found, 'reservationSet')[0], 'instancesSet')[0];
			if (!instance || text(instance, 'instanceState', 'name') === 'terminated') return null;
			return { region, instanceId, instance };
		} catch (error) {
			if (error instanceof AwsError && error.code === 'InvalidInstanceID.NotFound') return null;
			throw error;
		}
	}

	async function tagged(api: AwsClient, region: string, extra: Record<string, string[]> = {}) {
		const reservations = await api.all(region, 'DescribeInstances', 'reservationSet', {
			...filters({
				[`tag:${TAG}`]: ['node'],
				'instance-state-name': ['pending', 'running', 'stopping', 'stopped', 'shutting-down'],
				...extra
			}),
			MaxResults: '1000'
		});
		return reservations.flatMap((r) => items(r, 'instancesSet'));
	}

	async function latestUbuntu(api: AwsClient, region: string) {
		const images = await api.call(region, 'DescribeImages', {
			'Owner.1': CANONICAL,
			...filters({ name: [UBUNTU], state: ['available'], architecture: ['x86_64'] })
		});
		const newest = items(images, 'imagesSet').sort((a, b) =>
			(text(b, 'creationDate') ?? '').localeCompare(text(a, 'creationDate') ?? '')
		)[0];
		if (!newest) throw new AdapterError(`There is no Ubuntu 24.04 image in ${region}`);
		return { imageId: text(newest, 'imageId')!, rootDevice: text(newest, 'rootDeviceName') };
	}

	async function defaultSubnets(api: AwsClient, region: string) {
		const vpcs = await api.call(region, 'DescribeVpcs', filters({ isDefault: ['true'] }));
		const vpcId = text(items(vpcs, 'vpcSet')[0], 'vpcId');
		if (!vpcId) {
			throw new AdapterError(
				`${region} has no default VPC. Create one under VPC → Your VPCs → Actions → Create default VPC.`
			);
		}
		const subnets = await api.call(
			region,
			'DescribeSubnets',
			filters({ 'vpc-id': [vpcId], 'default-for-az': ['true'] })
		);
		const ids = items(subnets, 'subnetSet')
			.map((s) => ({ id: text(s, 'subnetId')!, zone: text(s, 'availabilityZone') ?? '' }))
			.sort((a, b) => a.zone.localeCompare(b.zone));
		if (!ids.length) throw new AdapterError(`The default VPC in ${region} has no subnets`);
		return { vpcId, subnets: ids };
	}

	/** The mesh port's security group in the VPC, created the first time. */
	async function ensureSecurityGroup(api: AwsClient, region: string, vpcId: string) {
		const found = await api.call(
			region,
			'DescribeSecurityGroups',
			filters({ 'group-name': [SECURITY_GROUP], 'vpc-id': [vpcId] })
		);
		let groupId = text(items(found, 'securityGroupInfo')[0], 'groupId');
		if (!groupId) {
			const created = await api.call(region, 'CreateSecurityGroup', {
				GroupName: SECURITY_GROUP,
				GroupDescription: 'Tramline: nodes reach each other’s WireGuard mesh',
				VpcId: vpcId,
				'TagSpecification.1.ResourceType': 'security-group',
				...tags('TagSpecification.1', { [TAG]: 'network' })
			});
			groupId = text(created, 'groupId')!;
		}
		try {
			await api.call(region, 'AuthorizeSecurityGroupIngress', {
				GroupId: groupId,
				'IpPermissions.1.IpProtocol': 'udp',
				'IpPermissions.1.FromPort': String(MESH_PORT),
				'IpPermissions.1.ToPort': String(MESH_PORT),
				'IpPermissions.1.IpRanges.1.CidrIp': '0.0.0.0/0',
				'IpPermissions.1.Ipv6Ranges.1.CidrIpv6': '::/0'
			});
		} catch (error) {
			if (!(error instanceof AwsError && error.code === 'InvalidPermission.Duplicate')) throw error;
		}
		return groupId;
	}

	const adapter = defineAdapter({
		meta: {
			id: 'aws',
			name: 'Amazon Web Services',
			icon: 'cloud',
			description: 'EC2 instances in your AWS account'
		},
		credentials,
		capabilities: {
			spot: false,
			arch: ['amd64'],
			autoProvision: true,
			gpus: false,
			inventory: true
		},

		async validate(creds) {
			const api = client(creds);
			await regions(api);
			// listing instances is the permission everything else starts from
			await api.call(HOME_REGION, 'DescribeInstances', { MaxResults: '5' });
		},

		async listRegions(creds): Promise<Region[]> {
			return (await regions(client(creds)))
				.map((id) => ({ id, name: PLACES[id] ? `${id} (${PLACES[id]})` : id }))
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		async listOffers(creds, region): Promise<Offer[]> {
			const api = client(creds);
			if (!(await regions(api)).includes(region)) {
				throw new AdapterError(`There is no region called ${region} enabled for this account`);
			}
			const types = await api.all(region, 'DescribeInstanceTypes', 'instanceTypeSet', {
				...filters({
					'instance-type': FAMILIES.map((family) => `${family}.*`),
					'processor-info.supported-architecture': ['x86_64'],
					'bare-metal': ['false']
				}),
				MaxResults: '100'
			});
			return types
				.map((t) => ({
					name: text(t, 'instanceType')!,
					vcpus: Number(text(t, 'vCpuInfo', 'defaultVCpus')),
					memoryMb: Number(text(t, 'memoryInfo', 'sizeInMiB'))
				}))
				.filter((t) => SIZE.test(t.name) && t.vcpus <= MAX_VCPUS)
				.sort(
					(a, b) => a.vcpus - b.vcpus || a.memoryMb - b.memoryMb || a.name.localeCompare(b.name)
				)
				.map((t) => ({
					id: t.name,
					region,
					name: t.name,
					vcpus: t.vcpus,
					memoryMb: t.memoryMb,
					diskGb: creds.diskGb,
					arch: 'amd64',
					gpu: null,
					// prices come from the AWS Price List API with Phase 8
					hourly: null,
					spotHourly: null,
					egressPerGb: null
				}));
		},

		async createNode(creds, spec) {
			const api = client(creds);
			const region = spec.region;
			const name = instanceName(spec.name);
			if ((await tagged(api, region, { 'tag:Name': [name] })).length) {
				throw new AdapterError(`${region} already has a Tramline instance called ${name}`);
			}
			const { imageId, rootDevice } = await latestUbuntu(api, region);
			const { vpcId, subnets } = await defaultSubnets(api, region);
			const groupId = creds.openMeshPort ? await ensureSecurityGroup(api, region, vpcId) : null;
			const userData = cloudInit({
				url: spec.install.url,
				token: spec.install.token,
				publicAddress: METADATA_ADDRESS
			});
			let lastError: AwsError | null = null;
			for (const subnet of subnets) {
				try {
					const run = await api.call(region, 'RunInstances', {
						ImageId: imageId,
						InstanceType: spec.offer,
						MinCount: '1',
						MaxCount: '1',
						UserData: Buffer.from(userData).toString('base64'),
						'NetworkInterface.1.DeviceIndex': '0',
						'NetworkInterface.1.SubnetId': subnet.id,
						'NetworkInterface.1.AssociatePublicIpAddress': 'true',
						'NetworkInterface.1.DeleteOnTermination': 'true',
						...(groupId ? { 'NetworkInterface.1.SecurityGroupId.1': groupId } : {}),
						'BlockDeviceMapping.1.DeviceName': rootDevice ?? '/dev/sda1',
						'BlockDeviceMapping.1.Ebs.VolumeSize': String(creds.diskGb),
						'BlockDeviceMapping.1.Ebs.VolumeType': 'gp3',
						'BlockDeviceMapping.1.Ebs.Encrypted': 'true',
						'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
						// tokens only, and not one hop further than the host: containers can't reach it
						'MetadataOptions.HttpEndpoint': 'enabled',
						'MetadataOptions.HttpTokens': 'required',
						'MetadataOptions.HttpPutResponseHopLimit': '1',
						'TagSpecification.1.ResourceType': 'instance',
						...tags('TagSpecification.1', { [TAG]: 'node', Name: name }),
						'TagSpecification.2.ResourceType': 'volume',
						...tags('TagSpecification.2', { [TAG]: 'node', Name: name })
					});
					const instanceId = text(items(run, 'instancesSet')[0], 'instanceId')!;
					return {
						id: `${region}/${instanceId}`,
						name,
						region,
						status: 'provisioning' as const,
						address: null,
						instructions: null
					};
				} catch (error) {
					if (!(error instanceof AwsError && error.code && NEXT_ZONE.has(error.code))) throw error;
					lastError = error;
				}
			}
			throw new AdapterError(
				`No availability zone in ${region} can run a ${spec.offer} right now (${lastError?.message}). Try another size or region.`
			);
		},

		async getNode(creds, id) {
			const found = await describe(client(creds), id);
			if (!found || tagOf(found.instance, TAG) !== 'node') return null;
			return toNode(found.instance, found.region);
		},

		async listNodes(creds) {
			const api = client(creds);
			const perRegion = await Promise.all(
				(await regions(api)).map(async (region) =>
					(await tagged(api, region)).map((instance) => toNode(instance, region))
				)
			);
			return perRegion.flat().sort((a, b) => a.id.localeCompare(b.id));
		},

		async destroyNode(creds, id) {
			const api = client(creds);
			const found = await describe(api, id);
			if (!found) return;
			if (tagOf(found.instance, TAG) !== 'node') {
				throw new AdapterError(
					`${found.instanceId} wasn't created by Tramline, so it was left alone`
				);
			}
			try {
				await api.call(found.region, 'TerminateInstances', { 'InstanceId.1': found.instanceId });
			} catch (error) {
				if (error instanceof AwsError && error.code === 'InvalidInstanceID.NotFound') return;
				throw error;
			}
		}
	});
	return adapter;
}

export const aws = awsAdapter();
