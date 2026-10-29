import { z } from 'zod';
import { cloudInit } from './cloud-init';
import { Offer, ProviderNode, Region, type ComputeAdapter, type NodeSpec } from './contract';

/**
 * The checks every adapter passes: credentials, regions and offers, then a
 * real machine through its whole life (create → enroll → destroy → gone, so
 * no orphans). Framework-free: call it from a test and it throws on the
 * first failure, or resolves with the steps it checked.
 */

export interface ConformanceOptions<Creds> {
	credentials: Creds;
	/** Credentials `validate` must reject, e.g. a wrong token. */
	invalidCredentials?: Creds;
	/** Defaults to the first region, and the cheapest offer in it. */
	region?: string;
	offer?: string;
	/** Where the test machine would enroll; it defaults to a fake install. */
	install?: { url: string; token: string };
	/** Resolves once the machine has enrolled, e.g. by polling the control plane. Skipped when absent. */
	enrolled?: (spec: NodeSpec, node: ProviderNode) => Promise<void>;
	/** How long a destroyed machine may take to disappear. */
	goneWithinMs?: number;
	pollMs?: number;
}

const random = () => crypto.randomUUID().slice(0, 8);

class ConformanceError extends Error {
	override name = 'ConformanceError';
}

function expect(condition: unknown, message: string): asserts condition {
	if (!condition) throw new ConformanceError(message);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new ConformanceError(
			`${what} doesn't match the contract: ${z.prettifyError(result.error)}`
		);
	}
	return result.data;
}

export async function conformance<Creds>(
	adapter: ComputeAdapter<Creds>,
	options: ConformanceOptions<Creds>
): Promise<string[]> {
	const steps: string[] = [];
	const step = (name: string) => steps.push(name);
	const { capabilities: can } = adapter;

	expect(
		/^[a-z][a-z0-9-]*$/.test(adapter.meta.id),
		`meta.id "${adapter.meta.id}" must be lowercase`
	);
	const creds = parse(adapter.credentials, options.credentials, 'The credentials');
	step('credentials match the schema');

	await adapter.validate(creds);
	if (options.invalidCredentials !== undefined) {
		const rejected = await adapter.validate(options.invalidCredentials).then(
			() => false,
			() => true
		);
		expect(rejected, 'validate accepted the invalid credentials');
	}
	step('validate');

	const regions = parse(z.array(Region), await adapter.listRegions(creds), 'listRegions');
	expect(regions.length > 0, 'listRegions returned no regions');
	const region = options.region ?? regions[0]!.id;
	expect(
		regions.some((r) => r.id === region),
		`Region ${region} isn't among those listRegions returned`
	);
	step('listRegions');

	const offers = parse(z.array(Offer), await adapter.listOffers(creds, region), 'listOffers');
	for (const offer of offers) {
		expect(offer.region === region, `Offer ${offer.id} is in ${offer.region}, not ${region}`);
		expect(
			can.arch.includes(offer.arch),
			`Offer ${offer.id} is ${offer.arch}, not a declared arch`
		);
		expect(can.gpus || !offer.gpu, `Offer ${offer.id} has a GPU, but capabilities.gpus is false`);
		expect(
			can.spot || offer.spotHourly === null,
			`Offer ${offer.id} has a spot price without spot`
		);
	}
	expect(!can.autoProvision || offers.length > 0, 'An adapter that provisions must offer sizes');
	const cheapest = [...offers].sort((a, b) => (a.hourly ?? 0) - (b.hourly ?? 0))[0];
	const offer = options.offer ?? cheapest?.id ?? 'any';
	step('listOffers');

	const install = options.install ?? {
		url: 'https://tramline.invalid',
		token: `tljoin_conformance_${random()}`
	};
	const spec: NodeSpec = {
		name: `conformance-${random()}`,
		region,
		offer,
		install: {
			...install,
			command: `curl -fsSL ${install.url}/install.sh | sudo sh -s -- --url ${install.url} --token ${install.token}`
		},
		userData: cloudInit(install),
		seedUrl: `${install.url}/api/agent/v1/seed/conformance-${random()}/`
	};
	const created = parse(ProviderNode, await adapter.createNode(creds, spec), 'createNode');
	try {
		expect(
			can.autoProvision || created.instructions,
			'An adapter that cannot provision must say what to do instead (instructions)'
		);
		step('createNode');

		if (can.inventory) {
			const found = await adapter.getNode(creds, created.id);
			expect(found && parse(ProviderNode, found, 'getNode').id === created.id, 'getNode lost it');
			const listed = parse(z.array(ProviderNode), await adapter.listNodes(creds), 'listNodes');
			expect(
				listed.some((n) => n.id === created.id),
				'listNodes does not include it'
			);
			step('getNode and listNodes');
		}

		if (options.enrolled) {
			await options.enrolled(spec, created);
			step('the machine enrolled');
		}
	} finally {
		await adapter.destroyNode(creds, created.id);
	}
	// destroying again must succeed: the control plane retries
	await adapter.destroyNode(creds, created.id);
	step('destroyNode');

	if (can.inventory) {
		const deadline = Date.now() + (options.goneWithinMs ?? 5 * 60_000);
		for (;;) {
			const gone =
				(await adapter.getNode(creds, created.id)) === null &&
				!(await adapter.listNodes(creds)).some((n) => n.id === created.id);
			if (gone) break;
			expect(Date.now() < deadline, `${created.id} is still there after destroyNode (an orphan)`);
			await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 5_000));
		}
		step('no orphans');
	}
	return steps;
}
