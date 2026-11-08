import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectGpus } from './gpus';
import { LABELS } from './runtime';
import { toRunSpec } from './spec';
import { desiredContainer } from './testing';

describe('detectGpus', () => {
	it('reads each GPU the NVIDIA driver describes', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'tramline-gpus-'));
		for (const [bus, model] of [
			['0000:01:00.0', 'NVIDIA L4'],
			['0000:02:00.0', 'NVIDIA H100 80GB HBM3']
		] as const) {
			mkdirSync(path.join(dir, bus));
			writeFileSync(
				path.join(dir, bus, 'information'),
				`Model: \t\t ${model}\nIRQ:   \t\t 120\nGPU UUID: \t GPU-1234\n`
			);
		}
		// a device without a readable description is skipped
		mkdirSync(path.join(dir, '0000:03:00.0'));
		expect(await detectGpus(dir)).toEqual([
			{ model: 'NVIDIA L4', vramMb: null },
			{ model: 'NVIDIA H100 80GB HBM3', vramMb: null }
		]);
	});

	it('finds none without the driver', async () => {
		expect(await detectGpus('/nonexistent/nvidia')).toEqual([]);
	});
});

describe('GPUs for containers', () => {
	it('hands a replica exactly its GPUs', () => {
		expect(toRunSpec(desiredContainer({ gpus: ['0', '2'] }), 'node_1').gpus).toEqual(['0', '2']);
	});

	it('leaves containers without GPUs as they were, spec hash included', () => {
		const spec = toRunSpec(desiredContainer(), 'node_1');
		expect(spec.gpus).toBeUndefined();
		// the hash of a container from before GPUs existed
		expect(spec.labels[LABELS.spec]).toBe(
			toRunSpec(desiredContainer({ gpus: undefined }), 'node_1').labels[LABELS.spec]
		);
		expect(JSON.stringify(desiredContainer())).not.toContain('gpus');
	});
});
