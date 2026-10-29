import { defineAdapter } from '@tramline/adapter-sdk';
import { z } from 'zod';

/**
 * Any Linux machine with Docker: a VM, a VPS, a spare box. There is no API
 * to call, so "creating" a node hands back the command that enrolls it, and
 * the machine is only known once its agent joins. Built in, with no account.
 */
export const manual = defineAdapter({
	meta: {
		id: 'manual',
		name: 'Any Linux machine',
		icon: 'terminal',
		description: 'Run one command on a machine you already have'
	},
	credentials: z.object({}),
	capabilities: {
		spot: false,
		arch: ['amd64', 'arm64'],
		autoProvision: false,
		gpus: false,
		inventory: false
	},
	async validate() {},
	async listRegions() {
		return [{ id: 'anywhere', name: 'Wherever the machine is' }];
	},
	// its cost is whatever the machine costs you; nothing to compare yet
	async listOffers() {
		return [];
	},
	async createNode(_creds, spec) {
		return {
			id: spec.name,
			name: spec.name,
			region: null,
			status: 'unknown',
			address: null,
			instructions: spec.install.command
		};
	},
	async getNode() {
		return null;
	},
	async listNodes() {
		return [];
	},
	async destroyNode() {}
});
