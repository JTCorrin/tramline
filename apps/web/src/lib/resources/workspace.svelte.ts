import { goto } from '$app/navigation';
import { page } from '$app/state';
import { api } from '#lib/api.js';
import { reportError } from '#lib/forms.js';
import type {
	Canvas,
	Environment,
	Project,
	ProjectEvent,
	StagedChanges
} from '@tramline/contracts';

export interface WorkspaceInit {
	project: Project;
	environments: Environment[];
	environmentId: string;
	canvas: Canvas;
	changes: StagedChanges;
}

const BUILTINS = [
	'TRAMLINE_PRIVATE_DOMAIN',
	'TRAMLINE_SERVICE_NAME',
	'TRAMLINE_ENVIRONMENT_NAME',
	'PORT'
];

/**
 * Client state for one open project: the selected environment, its canvas and
 * staged changes, kept live through the project's server-sent events.
 *
 * Panels that load their own data watch `version`, which increments whenever
 * the server reports a change in this project.
 */
export class Workspace {
	readonly project: Project;
	environments = $state<Environment[]>([]);
	environmentId = $state('');
	/** The service open in the side panel; mirrored to `?service=` for deep links. */
	selectedServiceId = $state<string | null>(null);
	canvas = $state<Canvas>()!;
	changes = $state<StagedChanges>()!;
	version = $state(0);
	deploying = $state(false);

	#client = api();
	#refreshTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(init: WorkspaceInit) {
		this.project = init.project;
		this.environments = init.environments;
		this.environmentId = init.environmentId;
		this.selectedServiceId = page.url.searchParams.get('service');
		this.canvas = init.canvas;
		this.changes = init.changes;
	}

	get selectedService() {
		return this.canvas.services.find((svc) => svc.id === this.selectedServiceId);
	}

	selectService(serviceId: string | null) {
		this.selectedServiceId = serviceId;
		this.setSearch({ service: serviceId });
	}

	get environment() {
		return this.environments.find((env) => env.id === this.environmentId)!;
	}

	/** Subscribes to project events; returns the unsubscribe function. */
	connect() {
		const source = new EventSource(`/api/v1/events?projectId=${this.project.id}`);
		source.onmessage = (message) => this.#onEvent(JSON.parse(message.data) as ProjectEvent);
		return () => source.close();
	}

	#onEvent(event: ProjectEvent) {
		this.version++;
		if (event.type === 'environments') this.refreshEnvironments();
		if (event.environmentId && event.environmentId !== this.environmentId) return;
		// coalesce bursts (e.g. a deploy publishes several events)
		clearTimeout(this.#refreshTimer);
		this.#refreshTimer = setTimeout(() => this.refresh(), 50);
	}

	async refresh() {
		const id = this.environmentId;
		try {
			const [canvas, changes] = await Promise.all([
				this.#client.environments.canvas(id),
				this.#client.environments.changes(id)
			]);
			// ignore responses for an environment we have since switched away from
			if (id !== this.environmentId) return;
			this.canvas = canvas;
			this.changes = changes;
		} catch (error) {
			reportError(error);
		}
	}

	async refreshEnvironments() {
		this.environments = await this.#client.environments.getAll({ projectId: this.project.id });
		if (!this.environments.some((env) => env.id === this.environmentId)) {
			await this.selectEnvironment(this.environments[0]!.id);
		}
	}

	async selectEnvironment(id: string) {
		this.environmentId = id;
		this.setSearch({ env: id });
		await this.refresh();
		this.version++;
	}

	async deploy() {
		this.deploying = true;
		try {
			await this.#client.environments.deploy(this.environmentId);
			await this.refresh();
		} finally {
			this.deploying = false;
		}
	}

	async discard() {
		await this.#client.environments.discard(this.environmentId);
		await this.refresh();
	}

	/**
	 * Completions for `${{ … }}` in a variable value: the service's own keys and
	 * builtins, `shared.*`, and every other service's keys.
	 */
	async referenceSuggestions(serviceId: string | null) {
		const environmentId = this.environmentId;
		const services = this.canvas.services;
		const [shared, ...perService] = await Promise.all([
			this.#client.variables.getAll({ environmentId }),
			...services.map((svc) => this.#client.variables.getAll({ environmentId, serviceId: svc.id }))
		]);
		const suggestions: string[] = [];
		services.forEach((svc, i) => {
			const keys = [...perService[i]!.map((v) => v.key), ...BUILTINS];
			for (const key of keys) suggestions.push(svc.id === serviceId ? key : `${svc.name}.${key}`);
		});
		for (const variable of shared) suggestions.push(`shared.${variable.key}`);
		return suggestions.filter((value, i) => suggestions.indexOf(value) === i);
	}

	/** Shallow URL update; does not rerun load functions. */
	setSearch(params: Record<string, string | null>) {
		// a throwaway copy for building the next URL, not reactive state
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const url = new URL(page.url.href);
		for (const [key, value] of Object.entries(params)) {
			if (value === null) url.searchParams.delete(key);
			else url.searchParams.set(key, value);
		}
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, new query
		goto(url, { state: page.state, shallow: true, replace: true });
	}
}
