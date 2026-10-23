import { EventEmitter } from 'node:events';

/**
 * Signals that some node's desired state may have changed, so long-polling
 * agents should recompute it, and that the reconciler should run.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function notifyNodes() {
	emitter.emit('change');
}

/** Resolves on the next change, or after `ms`. */
export function nextChange(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			emitter.off('change', done);
			signal?.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		emitter.once('change', done);
		signal?.addEventListener('abort', done, { once: true });
	});
}

export function onChange(listener: () => void) {
	emitter.on('change', listener);
	return () => {
		emitter.off('change', listener);
	};
}
