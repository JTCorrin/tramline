import { conformance } from '@tramline/adapter-sdk';
import { describe, expect, it } from 'vitest';
import { manual } from './index';

describe('manual adapter', () => {
	it('passes the conformance suite', async () => {
		const steps = await conformance(manual, { credentials: {} });
		expect(steps).toEqual([
			'credentials match the schema',
			'validate',
			'listRegions',
			'listOffers',
			'createNode',
			'destroyNode'
		]);
	});

	it('hands back the enroll command instead of creating anything', async () => {
		const node = await manual.createNode(
			{},
			{
				name: 'box',
				region: 'anywhere',
				offer: 'any',
				install: { url: 'https://t.test', token: 'tljoin_x', command: 'curl … --token tljoin_x' },
				userData: ''
			}
		);
		expect(node).toMatchObject({ id: 'box', instructions: 'curl … --token tljoin_x' });
		expect(await manual.listNodes({})).toEqual([]);
		expect(await manual.getNode({}, 'box')).toBeNull();
	});
});
