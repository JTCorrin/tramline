import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectGpus } from './gpus';

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
