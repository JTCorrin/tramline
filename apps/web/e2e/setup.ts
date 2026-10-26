import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { E2E_AGENT_IMAGE } from '../playwright.config';

/** Builds the agent image this checkout would publish; nodes run their mesh container from it. */
export default function setup() {
	if (process.env.TRAMLINE_E2E_DOCKER !== '1') return;
	const root = path.resolve(import.meta.dirname, '../../..');
	execFileSync(
		'docker',
		['build', '-q', '-f', 'apps/agent/Dockerfile', '-t', E2E_AGENT_IMAGE, '.'],
		{ cwd: root, stdio: ['ignore', 'ignore', 'inherit'] }
	);
}
