import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { E2E_NODE } from '../playwright.config';

const AGENT_HEALTH_PORT = '7172';

function stopAgent() {
	let pids: string;
	try {
		pids = execFileSync('lsof', ['-ti', `tcp:${AGENT_HEALTH_PORT}`, '-sTCP:LISTEN'], {
			encoding: 'utf8'
		}).trim();
	} catch {
		return; // not running
	}
	for (const pid of pids.split('\n').filter(Boolean)) {
		try {
			process.kill(Number(pid), 'SIGTERM');
		} catch {
			// already gone
		}
	}
}

/**
 * Removes the containers and networks the e2e agent created. The agent is
 * stopped mid-run, so draining containers would otherwise be left behind.
 * The agent is stopped first so it can't recreate them.
 * Only touches containers labelled with the e2e node's id.
 */
export default function teardown() {
	if (process.env.TRAMLINE_E2E_DOCKER !== '1') return;
	const file = path.resolve(import.meta.dirname, '../data/e2e.db');
	if (!existsSync(file)) return;

	const db = new Database(file, { readonly: true });
	const node = db.prepare("select id from node where name = 'local'").get() as
		{ id: string } | undefined;
	const environments = db.prepare('select id from environment').all() as { id: string }[];
	const services = db.prepare('select id from service').all() as { id: string }[];
	db.close();
	if (!node) return;

	// Playwright runs this before stopping its web servers. Stop the e2e agent first, or its
	// next heal pass could recreate what we remove below.
	stopAgent();

	const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
	// keep the ingress's own account of the run: route reloads and errors explain most 404s
	try {
		// Caddy logs to stderr
		const logs = execFileSync('sh', ['-c', `docker logs tramline-ingress-${node.id} 2>&1`], {
			encoding: 'utf8'
		});
		mkdirSync(path.resolve(import.meta.dirname, '../test-results'), { recursive: true });
		writeFileSync(path.resolve(import.meta.dirname, '../test-results/ingress.log'), logs);
	} catch {
		// no ingress this run
	}
	const containers = docker('ps', '-aq', '--filter', `label=tramline.node=${node.id}`);
	// one at a time: a container Docker can't kill (e.g. a zombie PID 1) mustn't stop the rest
	for (const id of containers.split('\n').filter(Boolean)) {
		try {
			execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
		} catch {
			console.warn(`[teardown] could not remove container ${id}`);
		}
	}
	// the builder's cache volume and the images built for this run's services
	try {
		execFileSync('docker', ['volume', 'rm', '-f', `tramline-buildkit-${node.id}`], {
			stdio: 'ignore'
		});
	} catch {
		// never created
	}
	// the bucket used by the backup tests
	try {
		execFileSync('docker', ['rm', '-f', 'tramline-e2e-s3'], { stdio: 'ignore' });
	} catch {
		// not running
	}
	try {
		// the Docker-in-Docker node, with everything that ran inside it
		execFileSync('docker', ['rm', '-f', '-v', E2E_NODE.container], { stdio: 'ignore' });
	} catch {
		// not started
	}
	// volumes the agent created for this run's services
	const volumes = docker(
		'volume',
		'ls',
		'-q',
		'--filter',
		`label=tramline.node=${node.id}`,
		'--filter',
		'label=tramline.role=volume'
	);
	if (volumes) docker('volume', 'rm', '-f', ...volumes.split('\n'));
	for (const { id } of services) {
		const images = docker('images', '-q', `tramline/${id}`);
		if (images)
			execFileSync('docker', ['rmi', '-f', ...new Set(images.split('\n'))], { stdio: 'ignore' });
	}
	// only this run's environments; another install on the same host may use the same naming scheme
	for (const { id } of environments) {
		try {
			execFileSync('docker', ['network', 'rm', `tl-${id}`], { stdio: 'ignore' });
		} catch {
			// never created
		}
	}
}
