import type { ProjectEvent } from '@tramline/contracts';
import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub that feeds `/api/v1/events`. Tramline runs as a single
 * process, so this is enough until the control plane is horizontally scaled.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publish(event: ProjectEvent) {
	emitter.emit(event.projectId, event);
}

export function subscribe(projectId: string, listener: (event: ProjectEvent) => void) {
	emitter.on(projectId, listener);
	return () => {
		emitter.off(projectId, listener);
	};
}
